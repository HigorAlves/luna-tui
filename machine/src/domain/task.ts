// Plain domain types for a task and everything attached to it. No TypeORM here — see
// ../adapters/persistence/schemas.ts for the persistence mapping of these same shapes.
import type { ArchiveReason, ArtifactKind, EngineId, JiraLink, RunInfo, StageEngines, StageRunCase, TaskClassification, TaskRoute, TaskSource, TaskState, EvidencePack, TriageRecord } from "@hardness/contracts";

import type { Retries } from "./transition.ts";

export interface TaskRow {
  id: string;
  title: string;
  description: string;
  criteria: string[];
  repoPath: string | null;
  /** The tracker item or PR the task came from. */
  source: TaskSource | null;
  /** The graph the task walks; `feature` is the full pipeline. */
  route: TaskRoute;
  branch: string | null;
  worktreePath: string | null;
  state: TaskState;
  retries: Retries;
  /** Where a paused or escalated task continues. */
  resumeTo: TaskState | null;
  /** Why the task is escalated, shown on the board. */
  reason: string | null;
  /** Why the task was archived; null for any other state. */
  archiveReason: ArchiveReason | null;
  /** Ready to run but waiting for a free concurrency slot. */
  queued: boolean;
  /** When it joined the queue: claims go in this order, so editing a queued ticket keeps its place. */
  queuedAt: Date | null;
  /** The branch's diff against its base after the last writable run; null until one ran. */
  diffAdded: number | null;
  diffRemoved: number | null;
  /** Verifying's results, passed over total, from its latest run; null until it ran. */
  testsPassed: number | null;
  testsTotal: number | null;
  /** The linked Jira issue as last seen; null when the task has none. */
  jira: JiraLink | null;
  /** When the task entered its current state (its latest transition; creation for a draft). Null only on rows older than the column. */
  stateSince: Date | null;
  /** The `Idempotency-Key` the work order that made the task came with, and a hash of its body. */
  idempotencyKey: string | null;
  requestHash: string | null;
  /** The task's own engine per pack, over luna.yaml's and the pack's default; a pack's entry is fixed once its stage starts. */
  stages: StageEngines;
  /** What triage_signals said about the issue the task came from; null when intake did not run it. */
  classification: TaskClassification | null;
  /** What triage decided about the ticket and why; null before it ran. */
  record: TriageRecord | null;
  /** The evidence pack of the task's change; null before verifying made one. */
  evidence: EvidencePack | null;
  /** The task's place in the change sequence (`task_seq`), bigint as pg returns it. */
  seq: string;
  createdAt: Date;
  updatedAt: Date;
}

export type StageRunStatus = "running" | "passed" | "failed" | "paused" | "aborted";

export interface StageRunRow {
  id: string;
  taskId: string;
  stage: TaskState;
  attempt: number;
  status: StageRunStatus;
  outcome: string | null;
  /** numeric, returned by pg as a string. */
  costUsd: string | null;
  turns: number | null;
  containerId: string | null;
  inputCommit: string | null;
  outputCommit: string | null;
  transcriptPath: string | null;
  /** Verifying only: one verdict per approved case, when the run reported them. */
  cases: StageRunCase[] | null;
  /** The engine the run started on; null for a host-only stage, or a run from before engines. */
  engine: EngineId | null;
  /** What the run's result named it ran on; null until it ends, and on rows from before. */
  runtime: string | null;
  modelId: string | null;
  sdkVersion: string | null;
  fingerprint: string | null;
  startedAt: Date;
  endedAt: Date | null;
}

/** What a run record keeps of the result's `run` (RFC 0003 §7). */
export interface RunFacts {
  runtime?: string;
  modelId?: string;
  sdkVersion?: string;
  fingerprint?: string;
}

/** The run's runtime, pinned model, SDK version and fingerprint; nothing for a result that named
 *  none (a script pack, an older runner). */
export const runFacts = (info: RunInfo | null | undefined): RunFacts =>
  info ? { runtime: info.runtime, modelId: info.modelId, sdkVersion: info.sdk.version, fingerprint: info.fingerprint } : {};

export interface EventRow {
  /** bigint, returned by pg as a string. */
  id: string;
  taskId: string;
  stageRunId: string | null;
  kind: string;
  payload: Record<string, unknown>;
  at: Date;
}

export interface ArtifactRow {
  id: string;
  stageRunId: string;
  taskId: string;
  kind: ArtifactKind;
  /** Relative to the run's output folder. */
  path: string;
  label: string;
  sha256: string;
  createdAt: Date;
}

export type Decision = "approved" | "sent_back" | "answered";

export interface ApprovalRow {
  id: string;
  taskId: string;
  /** The gate state this approval belongs to, e.g. `awaiting_approval`. */
  kind: TaskState;
  requested: Record<string, unknown>;
  decision: Decision | null;
  reason: string | null;
  /** What you sent with the decision, e.g. answers to triage questions. */
  response: Record<string, unknown> | null;
  createdAt: Date;
  decidedAt: Date | null;
}

export class TaskNotFoundError extends Error {
  constructor(id: string) {
    super(`task ${id} not found`);
    this.name = "TaskNotFoundError";
  }
}

/** The task has a stage running, so it cannot be deleted until you abort it. */
/** The task is no longer in a state the caller required: a tick decided on a stale row. */
export class TaskMovedError extends Error {
  constructor(id: string, state: TaskState, expected: Iterable<TaskState>) {
    super(`task ${id} is ${state}, not ${[...expected].join(" or ")}`);
    this.name = "TaskMovedError";
  }
}

export class TaskBusyError extends Error {
  constructor(id: string, state: TaskState) {
    super(`task ${id} is ${state}; abort it first`);
    this.name = "TaskBusyError";
  }
}

/** No plan to edit: the ticket is neither awaiting the plan's approval nor at the test check. */
export class NoPlanToEditError extends Error {
  constructor(id: string) {
    super(`task ${id} has no plan awaiting approval`);
    this.name = "NoPlanToEditError";
  }
}

/** No record to correct: the card has none yet, or it is not waiting at a gate (a stage is working on it, or it ended). */
export class RecordNotEditableError extends Error {
  constructor(id: string, why: string) {
    super(`the triage record of task ${id} cannot be corrected: ${why}`);
    this.name = "RecordNotEditableError";
  }
}

/** No questions to post: the card is not waiting for answers, or the open gate holds none. */
export class NoQuestionsToPostError extends Error {
  constructor(id: string, why = "the card has no open questions") {
    super(`task ${id}: ${why}`);
    this.name = "NoQuestionsToPostError";
  }
}

/** The open questions carry a token-shaped string: they are never posted, whoever taps. */
export class QuestionsCarrySecretError extends Error {
  constructor(id: string) {
    super(`task ${id}: a question carries a secret-shaped token and is not posted`);
    this.name = "QuestionsCarrySecretError";
  }
}

/** A work order reused an `Idempotency-Key` with another body. */
export class IdempotencyConflictError extends Error {
  /** The task the key already made, for the client to follow. */
  constructor(key: string, readonly taskId: string) {
    super(`Idempotency-Key "${key}" already made task ${taskId} from another body`);
    this.name = "IdempotencyConflictError";
  }
}

/** A task's engine for a pack cannot change once that pack's stage has run or is running. */
export class StageStartedError extends Error {
  constructor(id: string, pack: string) {
    super(`task ${id} has already run ${pack}; its engine is fixed`);
    this.name = "StageStartedError";
  }
}

/** A plan of High risk needs two distinct approvers, and this approval named none. */
export class ApproverRequiredError extends Error {
  constructor(id: string, gate: "plan" | "ship" = "plan") {
    super(
      gate === "ship"
        ? `task ${id}: a pack of High risk ships only with a ship approver who did not approve the plan; send your name as the approver`
        : `task ${id}: a plan of High risk needs two named approvers; send your name as the approver`,
    );
    this.name = "ApproverRequiredError";
  }
}

/** The same approver twice on a plan that needs two. */
export class SameApproverError extends Error {
  constructor(id: string, approver: string, gate: "plan" | "ship" = "plan") {
    super(
      gate === "ship"
        ? `task ${id}: ${approver} approved the plan; the ship approver of a High-risk pack must be someone else`
        : `task ${id}: ${approver} already approved this plan; a second, different approver must`,
    );
    this.name = "SameApproverError";
  }
}

/** No open `awaiting_test_check` gate, so there are no test cases to edit right now. */
export class NoCasesToEditError extends Error {
  constructor(id: string) {
    super(`task ${id} has no test cases awaiting your check`);
    this.name = "NoCasesToEditError";
  }
}

/** `PATCH /tasks/:id` naming another source: where a task came from never changes (400 `source_immutable`). */
export class SourceImmutableError extends Error {
  constructor(id: string) {
    super(`task ${id}'s source cannot change after it is created`);
    this.name = "SourceImmutableError";
  }
}

/** `PATCH /tasks/:id` moving the checkout of a task that already has a worktree or branch (409 `has_worktree`). */
export class RepoPathLockedError extends Error {
  constructor(id: string, branch: string | null) {
    super(`task ${id} already works on ${branch ?? "a worktree"}; its checkout cannot change`);
    this.name = "RepoPathLockedError";
  }
}

/** Two sources are the same when their fields are, in any order; an absent field equals null. */
export function sameSource(a: unknown, b: unknown): boolean {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value === null || typeof value !== "object") return value ?? null;
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined && v !== null)
        .sort(([x], [y]) => (x < y ? -1 : 1))
        .map(([k, v]) => [k, canonical(v)]),
    );
  };
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

/** The longest `lastRun.summary` a task snapshot carries. */
export const SUMMARY_MAX = 2000;

/** What a stage run said, from its `stage.finished` payload: the pack's summary, else its error, else triage's brief. */
export function runSummary(finished: Record<string, unknown> | null): string | null {
  const detail = finished?.detail && typeof finished.detail === "object" ? (finished.detail as Record<string, unknown>) : {};
  const said = [detail.summary, finished?.error, detail.error, detail.brief].find((value): value is string => typeof value === "string" && value.trim() !== "");
  return said === undefined ? null : said.slice(0, SUMMARY_MAX);
}
