// The Verifier stage: runs the target repo's own test suite against the implementer's
// worktree. A plain script, not an agent — like `shipRunner`, it needs only the repo
// itself, so it runs unconditionally, independent of MACHINE_AGENTS.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { exec } from "../sandbox/exec.ts";
import type { StageRunner } from "./runner.ts";

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

export const verifyRunner: StageRunner = async ({ task }) => {
  if (!task.worktreePath) {
    return { outcome: "fail", detail: { error: "no worktree to verify; the implementer never ran for real" } };
  }
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
  const result = await exec(bin, args, {
    cwd: task.worktreePath,
    env: { ...process.env, HARDNESS_STAGE: "verifying" },
  });
  if (result.code !== 0) {
    const output = (result.stderr || result.stdout).trim();
    return { outcome: "fail", detail: { error: `\`${command.join(" ")}\` failed:\n${output.slice(0, 4000)}` } };
  }
  return { outcome: "pass" };
};
