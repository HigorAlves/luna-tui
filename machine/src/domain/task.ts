// Plain domain types for a task and everything attached to it. No TypeORM here — see
// ../adapters/persistence/schemas.ts for the persistence mapping of these same shapes.
import type { ArtifactKind, JiraLink, StageEngines, StageRunCase, TaskRoute, TaskSource, TaskState } from "@hardness/contracts";

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
  startedAt: Date;
  endedAt: Date | null;
}

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

/** A work order reused an `Idempotency-Key` with another body. */
export class IdempotencyConflictError extends Error {
  constructor(key: string) {
    super(`Idempotency-Key "${key}" already made a task from another body`);
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

/** No open `awaiting_test_check` gate, so there are no test cases to edit right now. */
export class NoCasesToEditError extends Error {
  constructor(id: string) {
    super(`task ${id} has no test cases awaiting your check`);
    this.name = "NoCasesToEditError";
  }
}
