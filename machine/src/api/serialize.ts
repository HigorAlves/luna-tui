// Database rows to the API shapes in @hardness/contracts.
import {
  type Approval,
  type Artifact,
  COLUMN_OF,
  RUNNING,
  type StageRun,
  type Task,
  type TaskEvent,
  WAITING_ON_USER,
} from "@hardness/contracts";

import type { ApprovalRow, ArtifactRow, EventRow, StageRunRow, TaskRow } from "../db/entities.ts";

const iso = (date: Date | null) => (date ? date.toISOString() : null);

export const toTask = (row: TaskRow): Task => ({
  id: row.id,
  title: row.title,
  description: row.description,
  criteria: row.criteria,
  repoPath: row.repoPath,
  source: row.source,
  branch: row.branch,
  worktreePath: row.worktreePath,
  state: row.state,
  column: COLUMN_OF[row.state],
  waitingOnYou: WAITING_ON_USER.has(row.state),
  running: RUNNING.has(row.state) && !row.queued,
  queued: row.queued,
  retries: row.retries,
  resumeTo: row.resumeTo,
  reason: row.reason,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

export const toStageRun = (row: StageRunRow): StageRun => ({
  id: row.id,
  stage: row.stage,
  attempt: row.attempt,
  status: row.status,
  outcome: row.outcome,
  // numeric comes back from pg as a string.
  costUsd: row.costUsd === null ? null : Number(row.costUsd),
  turns: row.turns,
  startedAt: row.startedAt.toISOString(),
  endedAt: iso(row.endedAt),
});

export const toApproval = (row: ApprovalRow): Approval => ({
  id: row.id,
  kind: row.kind,
  requested: row.requested,
  decision: row.decision,
  reason: row.reason,
  response: row.response,
  createdAt: row.createdAt.toISOString(),
  decidedAt: iso(row.decidedAt),
});

export const toEvent = (row: EventRow): TaskEvent => ({
  id: String(row.id),
  taskId: row.taskId,
  kind: row.kind,
  payload: row.payload,
  at: row.at.toISOString(),
});

export const toArtifact = (row: ArtifactRow): Artifact => ({
  id: row.id,
  stageRunId: row.stageRunId,
  kind: row.kind,
  path: row.path,
  label: row.label,
  sha256: row.sha256,
  createdAt: row.createdAt.toISOString(),
});
