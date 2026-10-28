// The stages that run as packs in a sandbox: the machine writes a StageInput, the container
// runs the factory runner, and the machine ingests what the pack left in /out.
import type { CiContext, Ledger, PackId, ReviewContext, RunSummary, ServiceSpec, TaskState, ThreadsContext } from "@hardness/contracts";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, join } from "node:path";

import {
  type Workspace,
  branchBase,
  commonGitDir,
  gitIdentity,
  diffNameStatus,
  ensureWorktree,
  headCommit,
  dirtyFiles,
  resetWorktree,
  restoreFiles,
  workspaceFor,
} from "../../adapters/git/worktree.ts";
import type { Credential } from "../../adapters/docker/credentials.ts";
import { type SandboxResult, type SandboxRun, cacheVolumeFor, runSandbox } from "../../adapters/docker/docker.ts";
import { type DetectedChecks, detectChecks } from "../../domain/detect.ts";
import { lockedFilesRemoved, lockedFilesTouched } from "../../domain/locked-files.ts";
import { StuckDetector } from "../../domain/stuck.ts";
import { type ExecResult, exec } from "../../adapters/process/exec.ts";
import { ingestStageOutput, toStageResult } from "./ingest.ts";
import { PACK_LIMITS, buildStageInput } from "../../domain/stage-input.ts";
import { PolicyStore } from "../policy.ts";
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
  /** Finds the project's own check commands; the locked-test replay runs the test one. */
  detect?: (worktreePath: string) => Promise<DetectedChecks>;
  /** Each repo's luna.yaml; one store is shared so a bad edit warns once. */
  policies?: PolicyStore;
  /** The task's record (last implementing ledger, every run): implementing resumes its ledger from it, the retro reads it. */
  history?: (taskId: string) => Promise<{ ledger: Ledger | null; runs: RunSummary[] }>;
  /** Runs a host command; the locked-test replay uses it for the project's test command. */
  exec?: (
    command: string,
    args: string[],
    options: { env?: NodeJS.ProcessEnv; cwd?: string; signal?: AbortSignal; timeoutMs?: number; services?: Record<string, ServiceSpec> },
  ) => Promise<ExecResult>;
}

/** Every branch the pipeline writes starts with this; see `workspaceFor`. */
const TASK_BRANCH_PREFIX = "task/";

/** How long the original tests may take when replayed against a changed test file. */
const LOCKED_REPLAY_TIMEOUT_MS = 10 * 60_000;

const MINUTE = 60_000;
/** Kept read-only inside a writable stage's git dir: a planted hook or a rewritten config
 *  would otherwise run on the host, as you, at the next git command the machine issues. */
const GIT_READ_ONLY = ["hooks", "config"];

export interface AgentExtra {
  /** ci_watch: what the host fetched about the PR's CI, since the sandbox has no GitHub credential. */
  ci?: CiContext | null;
  /** reviewing: the PR's diff, files and comments, fetched by the host. */
  review?: ReviewContext | null;
  /** addressing: the PR's unresolved threads, fetched by the host. */
  threads?: ThreadsContext | null;
  /** reviewing_memory: the last implementing ledger and every earlier run, from the machine's records. */
  history?: { ledger: Ledger | null; runs: RunSummary[] } | null;
  /** setup: run over the repo checkout itself, read-only, no task worktree or branch. */
  checkout?: boolean;
}

export async function runAgent(deps: AgentDeps, context: StageContext, pack: PackId, extra: AgentExtra = {}): Promise<StageResult> {
  const { task } = context;
  if (!task.repoPath) {
    throw new Error("the task has no repoPath; create it with a repo to run real stages");
  }
  const limits = PACK_LIMITS[pack];
  if (extra.checkout && limits.writable) throw new Error(`${pack} is writable; a checkout run must be read-only`);
  const policy = await (deps.policies ?? sharedPolicies).for(task.repoPath);
  // The branch the pipeline would give this task today: `task/<id>-<slug>`, or the repo's
  // `jira.branch` pattern for a linked task.
  const owned = workspaceFor(task, task.repoPath, deps.worktreesDir, policy.jira?.branch);
  const workspace: Workspace = extra.checkout
    ? { branch: "", path: task.repoPath }
    : task.branch && task.worktreePath
      ? { branch: task.branch, path: task.worktreePath }
      : owned;
  // The branch is a structural gate: whatever a task row says, a writable stage only ever
  // commits to a branch the pipeline owns: a `task/` branch, the one it named for a linked
  // task, or, for a PR task, the PR's own head branch.
  const prBranch = task.source?.kind === "github_pr" ? task.source.headRef : null;
  if (limits.writable && !workspace.branch.startsWith(TASK_BRANCH_PREFIX) && workspace.branch !== prBranch && workspace.branch !== owned.branch) {
    return {
      outcome: "fail",
      detail: { error: `refusing to run ${pack} on branch ${workspace.branch}: the pipeline only writes ${TASK_BRANCH_PREFIX}* branches (or the branch it named for a Jira-linked task)` },
    };
  }
  if (!extra.checkout) await ensureWorktree(task.repoPath, workspace);
  // After a restart, the container the last machine started may still be running: its name and
  // the commit it started from come from the run row, and the sandbox waits on it instead.
  const resume = context.resume;
  const inputCommit = resume?.inputCommit ?? (await headCommit(workspace.path));
  const gitDir = await commonGitDir(task.repoPath);
  const container = resume?.container ?? `hardness-${task.id.slice(0, 8)}-${context.stage.replaceAll("_", "-")}-${context.attempt}`;
  const runDir = join(deps.stateDir, "runs", context.runId);
  if (!resume) await context.started?.({ container, inputCommit });

  const input = buildStageInput({
    task: { ...task, branch: workspace.branch },
    stage: context.stage,
    attempt: context.attempt,
    approvals: context.approvals,
    priorFindings: pack === "implementing" ? (context.priorFindings ?? []) : [],
    baseCommit: await branchBase(workspace.path, task.repoPath),
    ci: extra.ci ?? null,
    review: extra.review ?? null,
    threads: extra.threads ?? null,
    holdoutCases: policy.holdoutCases,
    qaTargets: policy.qaTargets,
    checks: policy.checks,
    history: extra.history ?? ((pack === "implementing" || pack === "reviewing_memory") && deps.history ? await deps.history(task.id) : null),
  });

  // Watches the transcript as it streams: a loop on one call is stopped before it spends the turn budget.
  const detector = new StuckDetector();
  // The SDK's session transcripts live per task on the host: a session outlives the attempt,
  // you can read it, and a later run can resume it.
  const sessionMount = join(deps.stateDir, "tasks", task.id, "session");
  await mkdir(sessionMount, { recursive: true });
  const sandbox = await (deps.sandbox ?? runSandbox)({
    name: container,
    attach: Boolean(resume),
    sessionMount,
    cacheVolume: cacheVolumeFor(task.repoPath),
    image: pack === "e2e" ? deps.qaImage : deps.image,
    runDir,
    worktree: workspace.path,
    writable: limits.writable,
    gitDir,
    gitReadOnly: GIT_READ_ONLY.filter((sub) => existsSync(join(gitDir, sub))),
    gitIdentity: limits.writable ? await gitIdentity(task.repoPath) : null,
    // The repo's services run beside every stage that runs its code; a read-only stage only reads.
    services: limits.writable ? policy.services : {},
    input: input as unknown as Record<string, unknown>,
    // The input's budget, which implementing scales with the plan's slice count.
    timeoutMs: input.limits.timeoutMs,
    credential: deps.credential,
    labels: { "dev.hardness.task": task.id },
    signal: context.signal,
    // The tab's label names the repo too: five repos' Build tabs read apart.
    onStarted: (name) =>
      void deps.watcher.follow(task.id, `#${task.id.slice(0, 8)} ${basename(task.repoPath!)} · ${task.title}`, workspace.path, name),
    onLine: (line) => detector.feed(line),
  });

  const base: StageResult = {
    outcome: "fail",
    // A checkout run has no workspace of the task's own to record.
    ...(extra.checkout ? {} : { workspace: { branch: workspace.branch, worktreePath: workspace.path } }),
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
  if (sandbox.timedOut) return failed(`timed out after ${input.limits.timeoutMs / MINUTE} minutes`);
  if (sandbox.stuck) return failed(`stuck: ${sandbox.stuck}`);

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

  // A usage window spent mid-run leaves no answer: pause until it resets. A run that still
  // finished with one keeps it; the answer is paid for, and the next stage finds out for
  // itself whether the window is open. The reset time rides along for the record.
  const unfinished = !output.ok || output.outcome === "fail" || (output.answer == null && output.outcome === "pass");
  if (output.rateLimited && unfinished) return dirty(merged({ ...mapped, outcome: "fail", rateLimited: true }));
  if (output.rateLimited) {
    mapped.rateLimited = undefined;
    mapped.detail = { ...mapped.detail, usageWindow: { resetsAt: output.resetsAt ?? null } };
  }
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

  // The agent stopped on purpose. Runners before the `escalated` outcome reported this as a pass.
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
    const left = await dirtyFiles(workspace.path);
    if (left.length > 0) {
      const who = pack === "implementing" ? "implementer" : "verifying";
      const named = left.slice(0, 10).join(", ") + (left.length > 10 ? `, and ${left.length - 10} more` : "");
      return dirty(merged({ ...mapped, outcome: "fail", detail: { error: `${who} left uncommitted changes: ${named}` } }));
    }
    // Tests present at the start of the run are locked; implementing has a test_change
    // escape hatch, verifying has none — it may only ever add a new test file.
    const nameStatus = await diffNameStatus(workspace.path, inputCommit, "HEAD");
    const locked = lockedFilesTouched(nameStatus);
    let replayed = false;
    let replayError: string | null = null;
    if (locked.length > 0) {
      // A test file that existed may gain cases (the repo's idiom for a new export), but the
      // tests that were there must still pass against the new code, unchanged. Put the
      // originals back, run the project's test command, then restore the agent's versions.
      // A deleted or renamed-away test file has nothing to replay and stays a hard fail.
      const removed = lockedFilesRemoved(nameStatus);
      const found = removed.length === 0 ? await (deps.detect ?? detectChecks)(workspace.path) : null;
      if (found?.test) {
        await restoreFiles(workspace.path, inputCommit, locked);
        const [cmd, ...args] = found.test;
        const ran = await (deps.exec ?? exec)(cmd!, args, {
          cwd: workspace.path,
          signal: context.signal,
          timeoutMs: LOCKED_REPLAY_TIMEOUT_MS,
          env: { ...process.env, HARDNESS_STAGE: pack },
          services: policy.services,
        });
        await resetWorktree(workspace.path);
        if (ran.code === 0) replayed = true;
        else {
          // Exit 127 is "command not found": the suite never ran (vitest not installed, say),
          // which is not the same as the original tests failing. Either way, show the tail.
          const tail = `${ran.stdout}\n${ran.stderr}`.trim().split("\n").slice(-12).join("\n");
          replayError =
            ran.code === 127
              ? `changed existing test file(s), and the test command could not run to prove them (\`${found.test.join(" ")}\`, exit 127; install what it needs first): ${locked.join(", ")}\n${tail}`
              : `changed existing test file(s) and the tests that were there no longer pass: ${locked.join(", ")}\n${tail}`;
        }
      }
    }
    if (replayed) mapped.detail = { ...mapped.detail, lockedFiles: locked, lockedTestsReplayed: true };
    // Where the run left the branch; a later test_change reverts verifying's tests by this.
    mapped.run = { ...mapped.run, outputCommit: await headCommit(workspace.path) };
    if (locked.length > 0 && !replayed) {
      // Undo the commit itself, so the next attempt does not start from it.
      await resetWorktree(workspace.path, inputCommit);
      const hint = pack === "implementing" ? " without a test_change request" : "";
      return merged({
        ...mapped,
        outcome: "fail",
        detail: {
          error: replayError ?? `modified existing test file(s)${hint}: ${locked.join(", ")}`,
          lockedFiles: locked,
        },
        findings: locked.map((path) => ({
          path,
          line: 0,
          start_line: null,
          severity: "test",
          title: "locked test file changed",
          body:
            replayError ??
            (pack === "implementing"
              ? "Tests present at the start of the run are locked; answer kind test_change instead of editing them."
              : "Tests present at the start of the run are locked; add a new test file instead of editing this one."),
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
        // How sure triage is and how risky the touched paths are: the timer approval reads both.
        ...(typeof answer?.confidence === "string" ? { confidence: answer.confidence } : {}),
        ...(typeof answer?.risk === "string" ? { risk: answer.risk } : {}),
      },
    });
  }
  if (pack === "test_design") {
    const cases = answerOf(output.answer)?.cases;
    return merged({ ...mapped, detail: { ...mapped.detail, summary: output.summary, cases: Array.isArray(cases) ? cases : [] } });
  }
  return merged(mapped);
}

/** The policy store for runners built without one (bootstrap passes the machine's). */
const sharedPolicies = new PolicyStore();

const answerOf = (answer: unknown): Record<string, unknown> | undefined =>
  answer && typeof answer === "object" ? (answer as Record<string, unknown>) : undefined;

// verifying, evidence, e2e, ci_watch and reviewing_memory are each wrapped in their own
// stage-specific runner in bootstrap/stages.ts (around the same runAgent call), so the
// blanket map below only needs the packs that are dispatched unmodified.
const AGENT_PACKS: PackId[] = ["triage", "test_design", "implementing"];

/** Runners for the stages that run as packs. Every other stage stays a stub. */
export function agentRunners(deps: AgentDeps): Partial<Record<TaskState, StageRunner>> {
  return Object.fromEntries(
    AGENT_PACKS.map((pack) => [pack, (context: StageContext) => runAgent(deps, context, pack)]),
  );
}
