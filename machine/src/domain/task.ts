// Plain domain types for a task and everything attached to it. No TypeORM here — see
// ../db/schemas.ts for the persistence mapping of these same shapes.
import type { ArtifactKind, TaskSource, TaskState } from "@hardness/contracts";

import type { Retries } from "../engine/transition.ts";

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
