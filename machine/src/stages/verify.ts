// The Verifier stage: runs the target repo's own test suite against the implementer's
// worktree. A plain script, not an agent — like `shipRunner`, it needs only the repo
// itself, so it runs unconditionally, independent of MACHINE_AGENTS.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { exec } from "../sandbox/exec.ts";
import type { StageRunner } from "./runner.ts";

/** Same order of magnitude as the implementer's own cap (agents.ts); a test suite that
 *  can't finish in that long is as stuck as a container that never returns. */
const VERIFY_TIMEOUT_MS = 30 * 60_000;

/** The command to run this repo's tests, or null if none of the known conventions fit. */
export function detectTestCommand(repoPath: string): [string, ...string[]] | null {
  const packageJson = join(repoPath, "package.json");
  if (existsSync(packageJson)) {
    const pkg = JSON.parse(readFileSync(packageJson, "utf8")) as { scripts?: Record<string, string> };
    if (pkg.scripts?.test) {
      if (existsSync(join(repoPath, "pnpm-lock.yaml"))) return ["pnpm", "test"];
      if (existsSync(join(repoPath, "yarn.lock"))) return ["yarn", "test"];
      return ["npm", "test"];
    }
  }
  if (existsSync(join(repoPath, "Cargo.toml"))) return ["cargo", "test"];
  return null;
}

export const verifyRunner: StageRunner = async ({ task, signal }) => {
  // The real implementer always records a workspace when it runs (see agents.ts's `base`
  // result), so a missing worktree here means implementing itself was stubbed — agents off
  // or no credential/image — not that a real implementer somehow skipped committing. Fail
  // here instead of passing would turn every stub-only run into a guaranteed escalation at
  // this stage, breaking the "traverse the whole graph with stubs only" path golden-task.mjs
  // relies on; behave like the stub that preceded this stage instead.
  if (!task.worktreePath) return { outcome: "pass" };
  const command = detectTestCommand(task.worktreePath);
  if (!command) {
    return {
      outcome: "fail",
      detail: {
        error: `don't know how to test this repo (no package.json test script or Cargo.toml) in ${task.worktreePath}`,
      },
    };
  }
  const [bin, ...args] = command;
  // A signal a test fixture can key off, to tell this official pipeline run apart from
  // an agent's own exploratory `npm test` during implementing (see fixtures/golden-flaky).
  // `signal` and `timeoutMs` make sure this subprocess actually dies when the task is
  // aborted or the repo's tests hang — like every other stage's runner is expected to.
  const result = await exec(bin, args, {
    cwd: task.worktreePath,
    env: { ...process.env, HARDNESS_STAGE: "verifying" },
    signal,
    timeoutMs: VERIFY_TIMEOUT_MS,
  });
  if (result.code !== 0) {
    const output = (result.stderr || result.stdout).trim();
    return { outcome: "fail", detail: { error: `\`${command.join(" ")}\` failed:\n${output.slice(0, 4000)}` } };
  }
  return { outcome: "pass" };
};
