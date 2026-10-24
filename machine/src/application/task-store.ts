// Everything Pipeline needs from storage. Every method here is plain CRUD except
// `withTaskLock`, whose Postgres implementation takes a row lock inside a transaction —
// the one seam where the transition engine's correctness depends on the storage layer.
import type { TaskState } from "@hardness/contracts";

import type { ApprovalRow, ArtifactRow, Decision, EventRow, StageRunRow, StageRunStatus, TaskRow } from "../domain/task.ts";

export interface NewTaskRow {
  title: string;
  description: string;
  criteria: string[];
  repoPath: string | null;
  source: TaskRow["source"];
}

export interface DecideApprovalInput {
  decision: Decision;
  reason: string | null;
  response: Record<string, unknown> | null;
}

export interface RecordEventInput {
  taskId: string;
  kind: string;
  payload: Record<string, unknown>;
  stageRunId: string | null;
}

export interface InsertStageRunInput {
  taskId: string;
  stage: TaskState;
  attempt: number;
}

export interface UpdateStageRunInput {
  status: StageRunStatus;
  outcome: string | null;
  containerId: string | null;
  transcriptPath: string | null;
  inputCommit: string | null;
  outputCommit: string | null;
  turns?: number | null;
  costUsd?: string | null;
  /** Marks the run as ended now (`clock_timestamp()` on Postgres — not a value the caller computes). */
  ended: true;
}

/** The writes `withTaskLock`'s callback makes inside the same transaction as the lock. */
export interface TaskTx {
  updateTask(id: string, patch: Partial<TaskRow>): Promise<void>;
  findOpenApproval(taskId: string): Promise<ApprovalRow | null>;
  decideApproval(open: ApprovalRow, decision: DecideApprovalInput): Promise<void>;
  /** Replaces an open approval's `requested`, leaving its decision (still open) untouched. */
  updateApprovalRequested(open: ApprovalRow, requested: Record<string, unknown>): Promise<void>;
  insertApproval(input: { taskId: string; kind: TaskState; requested: Record<string, unknown> }): Promise<void>;
  recordEvent(input: RecordEventInput): Promise<EventRow>;
}

export interface TaskStore {
  createTask(input: NewTaskRow): Promise<TaskRow>;
  listTasks(): Promise<TaskRow[]>;
  getTask(id: string): Promise<TaskRow | null>;
  findTaskBySource(repo: string, number: number): Promise<TaskRow | null>;
  updateTask(id: string, patch: Partial<TaskRow>): Promise<void>;
  deleteTask(id: string): Promise<void>;
  findStuckTasks(running: ReadonlySet<TaskState>): Promise<TaskRow[]>;
  markRunningStageRunsAborted(): Promise<void>;
  /** Finds the longest-queued task and claims it (clearing `queued`) under a row lock, so
   *  two slots freeing at once cannot both claim the same task. Null when none is queued. */
  claimOldestQueuedTask(): Promise<TaskRow | null>;

  /** Locks the task row for the rest of `fn`, so two transitions on the same task can never
   *  interleave. Throws `TaskNotFoundError`-shaped errors are the caller's job, not the
   *  store's — `fn` only ever sees a row that exists. */
  withTaskLock<T>(id: string, fn: (task: TaskRow, tx: TaskTx) => Promise<T>): Promise<T>;

  listStageRuns(taskId: string): Promise<StageRunRow[]>;
  countStageRunAttempts(taskId: string, stage: TaskState): Promise<number>;
  insertStageRun(input: InsertStageRunInput): Promise<string>;
  updateStageRun(id: string, patch: UpdateStageRunInput): Promise<void>;

  listApprovals(taskId: string): Promise<ApprovalRow[]>;

  listArtifacts(taskId: string): Promise<ArtifactRow[]>;
  insertArtifact(input: Omit<ArtifactRow, "id" | "createdAt">): Promise<void>;

  listEvents(taskId: string): Promise<EventRow[]>;
  /** Every `stage.finished` event for the task, newest first. */
  findFinishedEvents(taskId: string): Promise<EventRow[]>;
  recordEvent(input: RecordEventInput): Promise<EventRow>;
}
