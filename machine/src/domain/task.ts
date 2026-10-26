// Plain domain types for a task and everything attached to it. No TypeORM here — see
// ../adapters/persistence/schemas.ts for the persistence mapping of these same shapes.
import type { ArtifactKind, TaskSource, TaskState } from "@hardness/contracts";

import type { Retries } from "./transition.ts";

export interface TaskRow {
  id: string;
  title: string;
  description: string;
  criteria: string[];
  repoPath: string | null;
  /** The tracker item the task came from. */
  source: TaskSource | null;
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

/** No open `awaiting_approval` gate to edit, so there is no plan on the ticket right now. */
export class NoPlanToEditError extends Error {
  constructor(id: string) {
    super(`task ${id} has no plan awaiting approval`);
    this.name = "NoPlanToEditError";
  }
}
