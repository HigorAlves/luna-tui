// The stages that run as orc packs in a sandbox: the machine writes a StageInput, the
// container runs `orc-stage run`, and the machine ingests what the pack left in /out.
import type { PackId, TaskState } from "@hardness/contracts";
import { join } from "node:path";

import {
  type Workspace,
  commonGitDir,
  ensureWorktree,
  headCommit,
  isDirty,
  resetWorktree,
  workspaceFor,
} from "../git/worktree.ts";
import type { Watcher } from "../herdr/watch.ts";
import type { Credential } from "../sandbox/credentials.ts";
import { type SandboxResult, type SandboxRun, runSandbox } from "../sandbox/docker.ts";
import { ingestStageOutput, toStageResult } from "./ingest.ts";
import { PACK_LIMITS, buildStageInput } from "./input.ts";
import type { StageContext, StageResult, StageRunner } from "./runner.ts";

export interface AgentDeps {
  image: string;
  credential: Credential;
  worktreesDir: string;
  stateDir: string;
  watcher: Watcher;
  /** Replaces the docker sandbox; tests pass a fake. */
  sandbox?: (run: SandboxRun) => Promise<SandboxResult>;
}

const MINUTE = 60_000;

async function runAgent(deps: AgentDeps, context: StageContext, pack: PackId): Promise<StageResult> {
  const { task } = context;
  if (!task.repoPath) {
    throw new Error("the task has no repoPath; create it with a repo to run real stages");
  }
  const limits = PACK_LIMITS[pack];
  const workspace: Workspace =
    task.branch && task.worktreePath
      ? { branch: task.branch, path: task.worktreePath }
      : workspaceFor(task, task.repoPath, deps.worktreesDir);
  await ensureWorktree(task.repoPath, workspace);
  const inputCommit = await headCommit(workspace.path);
  const container = `hardness-${task.id.slice(0, 8)}-${context.stage.replaceAll("_", "-")}-${context.attempt}`;
  const runDir = join(deps.stateDir, "runs", context.runId);

  // priorFindings come from the verifying loop, wired in with that stage.
  const input = buildStageInput({
    task: { ...task, branch: workspace.branch },
    stage: context.stage,
    attempt: context.attempt,
    approvals: context.approvals,
    priorFindings: [],
  });

  const sandbox = await (deps.sandbox ?? runSandbox)({
    name: container,
    image: deps.image,
    runDir,
    worktree: workspace.path,
    writable: limits.writable,
    gitDir: await commonGitDir(task.repoPath),
    input: input as unknown as Record<string, unknown>,
    timeoutMs: limits.timeoutMs,
    credential: deps.credential,
    labels: { "dev.hardness.task": task.id },
    signal: context.signal,
    onStarted: (name) =>
      void deps.watcher.follow(task.id, `#${task.id.slice(0, 8)} ${task.title}`, workspace.path, name),
  });

  const base: StageResult = {
    outcome: "fail",
    workspace: { branch: workspace.branch, worktreePath: workspace.path },
    run: { containerId: container, transcriptPath: sandbox.transcriptPath, inputCommit },
  };
  // However this run ends without a clean, committed answer, the next attempt should not
  // inherit whatever it left half-edited on disk.
  const dirty = async <T>(result: T): Promise<T> => {
    if (limits.writable) await resetWorktree(workspace.path);
    return result;
  };
  const failed = (error: string): Promise<StageResult> => dirty({ ...base, detail: { error } });

  if (sandbox.aborted) return failed("aborted");
  if (sandbox.timedOut) return failed(`timed out after ${limits.timeoutMs / MINUTE} minutes`);

  let ingested;
  try {
    ingested = await ingestStageOutput({ outDir: join(runDir, "out"), runId: context.runId, stateDir: deps.stateDir });
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException)?.code === "ENOENT";
    return failed(
      missing
        ? `the container left no result (exit code ${sandbox.exitCode}); see the transcript`
        : String((error as Error).message ?? error),
    );
  }
  const { output } = ingested;
  const mapped = toStageResult(ingested);
  const merged = (result: StageResult): StageResult => ({
    ...base,
    ...result,
    run: { ...base.run, ...result.run },
  });

  if (output.rateLimited) return dirty(merged({ ...mapped, outcome: "fail", rateLimited: true }));
  if (output.outcome === "fail" || !output.ok) {
    return dirty(
      merged({ ...mapped, outcome: "fail", detail: { ...mapped.detail, error: output.error ?? output.summary } }),
    );
  }
  if (output.outcome === "needs_input") {
    return merged({ ...mapped, detail: { summary: output.summary, questions: output.needsInput ?? [] } });
  }
  if (output.outcome === "test_change") {
    return merged({ ...mapped, detail: { request: output.summary } });
  }

  // outcome pass
  if (pack === "implementing") {
    // The implementer commits inside the container; anything left over is not part of the answer.
    if (await isDirty(workspace.path)) {
      return dirty(merged({ ...mapped, outcome: "fail", detail: { error: "implementer left uncommitted changes" } }));
    }
  }
  if (pack === "triage") {
    // The pack's result.json carries the summary only; criteria stay the ticket's until orc returns them.
    return merged({
      ...mapped,
      detail: { ...mapped.detail, brief: output.summary, criteria: task.criteria, assumptions: [] },
    });
  }
  return merged(mapped);
}

const AGENT_PACKS: PackId[] = [
  "triage",
  "test_design",
  "implementing",
  "verifying",
  "e2e",
  "evidence",
  "ci_watch",
  "reviewing_memory",
];

/** Runners for the stages that run as orc packs. Every other stage stays a stub. */
export function agentRunners(deps: AgentDeps): Partial<Record<TaskState, StageRunner>> {
  return Object.fromEntries(
    AGENT_PACKS.map((pack) => [pack, (context: StageContext) => runAgent(deps, context, pack)]),
  );
}
