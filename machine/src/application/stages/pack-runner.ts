// The stages that run as orc packs in a sandbox: the machine writes a StageInput, the
// container runs `orc-stage run`, and the machine ingests what the pack left in /out.
import type { PackId, TaskState } from "@hardness/contracts";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  type Workspace,
  commonGitDir,
  gitIdentity,
  diffNameStatus,
  ensureWorktree,
  headCommit,
  isDirty,
  resetWorktree,
  workspaceFor,
} from "../../adapters/git/worktree.ts";
import type { Credential } from "../../adapters/docker/credentials.ts";
import { type SandboxResult, type SandboxRun, runSandbox } from "../../adapters/docker/docker.ts";
import { lockedFilesTouched } from "../../domain/locked-files.ts";
import { ingestStageOutput, toStageResult } from "./ingest.ts";
import { PACK_LIMITS, buildStageInput } from "../../domain/stage-input.ts";
import type { StageContext, StageResult, StageRunner, Watcher } from "../ports.ts";

export interface AgentDeps {
  /** The base stage image. */
  image: string;
  /** The image with browsers, used by the e2e pack. */
  qaImage: string;
  credential: Credential;
  worktreesDir: string;
  stateDir: string;
  watcher: Watcher;
  /** Replaces the docker sandbox; tests pass a fake. */
  sandbox?: (run: SandboxRun) => Promise<SandboxResult>;
}

const MINUTE = 60_000;
/** Kept read-only inside a writable stage's git dir: a planted hook or a rewritten config
 *  would otherwise run on the host, as you, at the next git command the machine issues. */
const GIT_READ_ONLY = ["hooks", "config"];

export async function runAgent(deps: AgentDeps, context: StageContext, pack: PackId): Promise<StageResult> {
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
  const gitDir = await commonGitDir(task.repoPath);
  const container = `hardness-${task.id.slice(0, 8)}-${context.stage.replaceAll("_", "-")}-${context.attempt}`;
  const runDir = join(deps.stateDir, "runs", context.runId);

  const input = buildStageInput({
    task: { ...task, branch: workspace.branch },
    stage: context.stage,
    attempt: context.attempt,
    approvals: context.approvals,
    priorFindings: pack === "implementing" ? (context.priorFindings ?? []) : [],
  });

  const sandbox = await (deps.sandbox ?? runSandbox)({
    name: container,
    image: pack === "e2e" ? deps.qaImage : deps.image,
    runDir,
    worktree: workspace.path,
    writable: limits.writable,
    gitDir,
    gitReadOnly: GIT_READ_ONLY.filter((sub) => existsSync(join(gitDir, sub))),
    gitIdentity: limits.writable ? await gitIdentity(task.repoPath) : null,
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
    const answered = answerOf(output.answer)?.questions;
    return merged({
      ...mapped,
      detail: {
        summary: output.summary,
        questions: Array.isArray(answered) ? answered : (output.needsInput ?? []),
        ...(output.answer ? { answer: output.answer } : {}),
      },
    });
  }
  if (output.outcome === "test_change") {
    return merged({ ...mapped, detail: { request: output.summary } });
  }

  // The agent stopped on purpose. orc before the `escalated` outcome reported this as a pass.
  const stopped = answerOf(output.answer);
  if (output.outcome === "escalated" || stopped?.kind === "escalated") {
    return dirty(
      merged({
        ...mapped,
        outcome: "escalated",
        detail: {
          ...mapped.detail,
          summary: output.summary,
          reason: typeof stopped?.reason === "string" && stopped.reason ? stopped.reason : output.summary,
          options: Array.isArray(stopped?.options) ? stopped.options : [],
        },
      }),
    );
  }

  // outcome pass
  if (pack === "implementing" || pack === "verifying") {
    // Both commit inside the container; anything left over is not part of the answer.
    if (await isDirty(workspace.path)) {
      const who = pack === "implementing" ? "implementer" : "verifying";
      return dirty(merged({ ...mapped, outcome: "fail", detail: { error: `${who} left uncommitted changes` } }));
    }
    // Tests present at the start of the run are locked; implementing has a test_change
    // escape hatch, verifying has none — it may only ever add a new test file.
    const locked = lockedFilesTouched(await diffNameStatus(workspace.path, inputCommit, "HEAD"));
    if (locked.length > 0) {
      // Undo the commit itself, so the next attempt does not start from it.
      await resetWorktree(workspace.path, inputCommit);
      const hint = pack === "implementing" ? " without a test_change request" : "";
      return merged({
        ...mapped,
        outcome: "fail",
        detail: {
          error: `modified existing test file(s)${hint}: ${locked.join(", ")}`,
          lockedFiles: locked,
        },
        findings: locked.map((path) => ({
          path,
          line: 0,
          start_line: null,
          severity: "test",
          title: "locked test file changed",
          body:
            pack === "implementing"
              ? "Tests present at the start of the run are locked; answer kind test_change instead of editing them."
              : "Tests present at the start of the run are locked; add a new test file instead of editing this one.",
          suggestion_code: null,
          confidence: 1,
        })),
      });
    }
  }
  if (pack === "triage") {
    const answer = answerOf(output.answer);
    const list = (value: unknown, fallback: unknown[]): unknown[] => (Array.isArray(value) ? value : fallback);
    return merged({
      ...mapped,
      detail: {
        ...mapped.detail,
        brief: typeof answer?.summary === "string" ? answer.summary : output.summary,
        criteria: list(answer?.criteria, task.criteria),
        assumptions: list(answer?.assumptions, []),
        slices: list(answer?.slices, []),
      },
    });
  }
  if (pack === "test_design") {
    const tests = await listTests(join(runDir, "out"), output.answer, output.artifacts);
    const cases = answerOf(output.answer)?.cases;
    return merged({
      ...mapped,
      detail: { ...mapped.detail, summary: output.summary, tests, cases: Array.isArray(cases) ? cases : [] },
    });
  }
  return merged(mapped);
}

const answerOf = (answer: unknown): Record<string, unknown> | undefined =>
  answer && typeof answer === "object" ? (answer as Record<string, unknown>) : undefined;

const TESTS_DIR = "files/tests/";

/** The test files test_design wrote: its answer, `files/tests/manifest.json`, and the test artifacts. */
async function listTests(
  outDir: string,
  answer: unknown,
  artifacts: Array<{ kind: string; path: string }>,
): Promise<string[]> {
  const found = new Set<string>();
  const add = (value: unknown) => {
    if (Array.isArray(value)) for (const item of value) if (typeof item === "string" && item) found.add(item);
  };
  add(answerOf(answer)?.tests);
  try {
    add(JSON.parse(await readFile(join(outDir, TESTS_DIR, "manifest.json"), "utf8")).tests);
  } catch {
    // no manifest, or not JSON: the answer and artifacts still count
  }
  for (const artifact of artifacts) {
    if (artifact.kind !== "test" || artifact.path === `${TESTS_DIR}manifest.json`) continue;
    found.add(artifact.path.startsWith(TESTS_DIR) ? artifact.path.slice(TESTS_DIR.length) : artifact.path);
  }
  return [...found].sort();
}

// verifying, evidence, e2e, ci_watch and reviewing_memory are each wrapped in their own
// stage-specific runner in bootstrap/stages.ts (around the same runAgent call), so the
// blanket map below only needs the packs that are dispatched unmodified.
const AGENT_PACKS: PackId[] = ["triage", "test_design", "implementing"];

/** Runners for the stages that run as orc packs. Every other stage stays a stub. */
export function agentRunners(deps: AgentDeps): Partial<Record<TaskState, StageRunner>> {
  return Object.fromEntries(
    AGENT_PACKS.map((pack) => [pack, (context: StageContext) => runAgent(deps, context, pack)]),
  );
}
