// The real runs of the build-helper eval (RFC 0013, phase 5): `runAgent` for `implementing`, driven as `rig()` in machine's helper-runs.e2e.test.ts drives it,
// but with the real runtimes: the docker sandbox, the machine's credentials and egress, the real helper coordinator and the replayed design servers.
// Local only, like every eval; it needs a model credential and the stage image. Its report shaping is tested in build-helper.test.ts.
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EngineId } from "@hardness/contracts";
import { machineCredentials } from "@hardness/machine/credentials";
import { loadConfig } from "@hardness/machine/config";
import { buildEgress } from "@hardness/machine/egress";
import { exec } from "@hardness/machine/exec";
import { replayMcp } from "@hardness/machine/mcp-replay";
import { type AgentDeps, runAgent } from "@hardness/machine/pack-runner";
import { PolicyStore } from "@hardness/machine/policy";
import { tracesFromEnv } from "@hardness/machine/telemetry";

import { type BuildTrial, type LoadedBuildCase } from "./build-helper.ts";
import { FIXTURE_PREFIX, mcpServersOf } from "./cases.ts";
import { evalSandbox } from "./sandbox.ts";

const TASK = "eeeeeeee-0000-4000-8000-000000000001";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, "-c", "user.name=evals", "-c", "user.email=evals@example.invalid", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).trim();

export interface BuildRunOptions {
  engine: EngineId;
  image: string;
  /** Where the fixture repos are copied from (the checkout's root). */
  root: string;
  /** Where each run's scratch folder is made. */
  scratch?: string;
}

/** One card's `implementing` run: on a fresh copy of the fixture repo, with delegation on or off. Returns what the run left; the scratch folder stays under the OS temp dir, so a failed case can be read. */
export async function runBuildTrial(c: LoadedBuildCase, delegation: "on" | "off", options: BuildRunOptions): Promise<BuildTrial> {
  if (!c.repoPath.startsWith(FIXTURE_PREFIX)) throw new Error(`${c.id}: the repository ${c.repoPath} is not a fixture`);
  const root = realpathSync(mkdtempSync(join(options.scratch ?? tmpdir(), `build-helper-${c.id}-${delegation}-`)));
  const repo = join(root, "repo");
  cpSync(join(options.root, c.repoPath), repo, { recursive: true, filter: (src) => !/[\\/](\.golden|node_modules|\.git)([\\/]|$)/.test(src.slice(join(options.root, c.repoPath).length)) });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "tests: the card's scenario tests");
  const tests = git(repo, "rev-parse", "HEAD");

  const machineConfig = loadConfig(process.env);
  const sandbox = evalSandbox("implementing", machineConfig.egress.relay);
  const policies = new PolicyStore({ machinePolicy: machineConfig.sandboxPolicy });
  const egress = buildEgress({ egress: machineConfig.egress, runnerImage: options.image, traces: tracesFromEnv(), sandboxPolicy: machineConfig.sandboxPolicy }, policies);
  const servers = mcpServersOf(c.mcpDir);
  const deps = {
    image: options.image,
    qaImage: process.env.RUNNER_QA_IMAGE ?? "hardness-runner-qa:dev",
    credentials: machineCredentials(sandbox.credentials),
    worktreesDir: join(root, "worktrees"),
    stateDir: join(root, "state"),
    watcher: { follow: async () => {}, close: async () => {} },
    // The design servers are replayed, never connected: the hand-written Figma answers of the case's ui_design folder.
    mcpFor: () => replayMcp(servers, c.mcpDir),
    mcpUntrusted: "deny",
    // The one switch between the two runs: a card whose design is off never delegates.
    design: { cardOff: async () => delegation === "off", picked: async () => [] },
    hostExec: exec,
    policies,
    ...(egress ? { egress } : {}),
  } as unknown as AgentDeps;

  const rows: BuildTrial["rows"] = [];
  const abort = new AbortController();
  const link = `https://www.figma.com/design/${c.fileKey}/eval?node-id=${c.nodeId.replace(":", "-")}`;
  const context = {
    task: { id: TASK, title: c.title, description: `${c.description} ${link}`, criteria: c.slices.map((s) => s.title), repoPath: repo, source: null, branch: null, worktreePath: null },
    stage: "implementing",
    attempt: 1,
    runId: `build-helper-${c.id}-${delegation}`,
    approvals: [{ id: "ap1", kind: "awaiting_approval", decision: "approved", requested: { brief: c.description, criteria: [], assumptions: [], slices: c.slices, design: { spec: c.spec } } }],
    signal: abort.signal,
    engine: options.engine,
    budgetMinutes: 30,
    emit: async (kind: string, payload: unknown) => void rows.push({ kind, payload: payload as Record<string, unknown> }),
    note: async () => {},
  } as unknown as Parameters<typeof runAgent>[1];

  const started = Date.now();
  const result = await runAgent(deps, context, "implementing", { testsFiles: c.testsFiles });
  const wallMs = Date.now() - started;
  // The card's branch is in the machine's own repository; its checkpoint ref in the fixture repo (`refs/luna/wip/<branch>`) holds the same tip.
  const branch = result.workspace?.branch;
  let changed: string[] = [];
  if (branch) {
    try {
      changed = git(repo, "diff", "--name-only", `${tests}..refs/luna/wip/${branch}`).split("\n").filter(Boolean);
    } catch {
      // no checkpoint: the run left no branch to read, and the report says so by listing no files
    }
  }
  const detail = (result.detail ?? {}) as { escalation?: unknown };
  return {
    delegation,
    outcome: result.outcome,
    ...(typeof detail.escalation === "string" ? { escalation: detail.escalation } : {}),
    wallMs,
    changed,
    rows: rows.filter((r) => r.kind.startsWith("build.helper_")),
  };
}
