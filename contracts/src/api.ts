// HTTP and SSE shapes between the machine and the board. Requests are validated with
// these schemas; responses follow the interfaces.
import { z } from "zod";

import type { Column, TaskState } from "./index.ts";
import { type ArtifactKind, StageOutcome, TaskSource } from "./stage.ts";

export const NewTaskInput = z.object({
  title: z.string().trim().min(1),
  description: z.string().optional(),
  criteria: z.array(z.string().trim().min(1)).optional(),
  repoPath: z.string().nullable().optional(),
  source: TaskSource.nullable().optional(),
});
export type NewTaskInput = z.infer<typeof NewTaskInput>;

/** `PATCH /tasks/:id`: only the fields given change. */
export const UpdateTaskInput = z.object({
  title: z.string().trim().min(1).optional(),
  description: z.string().optional(),
  criteria: z.array(z.string().trim().min(1)).optional(),
  repoPath: z.string().nullable().optional(),
  source: TaskSource.nullable().optional(),
});
export type UpdateTaskInput = z.infer<typeof UpdateTaskInput>;

export const DecisionInput = z.object({
  decision: z.enum(["approved", "sent_back"]),
  // Clients may send `null` for "no reason" rather than omitting the field.
  reason: z.string().nullable().optional(),
});
export type DecisionInput = z.infer<typeof DecisionInput>;

export const AnswersInput = z.object({
  answers: z.record(z.string(), z.string()),
});
export type AnswersInput = z.infer<typeof AnswersInput>;

/** Dev only: queue results for a stub stage, e.g. three failures for `verifying`. */
export const StubPlanInput = z.object({
  stage: z.string(),
  results: z
    .array(
      z.object({
        outcome: StageOutcome,
        rateLimited: z.boolean().optional(),
        detail: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .min(1),
});
export type StubPlanInput = z.infer<typeof StubPlanInput>;

export interface Retries {
  verify: number;
  e2e: number;
  ci: number;
  total: number;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  criteria: string[];
  repoPath: string | null;
  /** The tracker item this task came from, if any. */
  source: TaskSource | null;
  branch: string | null;
  worktreePath: string | null;
  state: TaskState;
  column: Column;
  /** The task is at a gate (or escalated) and waits for you. */
  waitingOnYou: boolean;
  /** A stage is running right now. */
  running: boolean;
  /** Ready to run, but waiting for a free concurrency slot. */
  queued: boolean;
  retries: Retries;
  resumeTo: TaskState | null;
  reason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StageRun {
  id: string;
  stage: TaskState;
  attempt: number;
  status: "running" | "passed" | "failed" | "paused" | "aborted";
  outcome: string | null;
  /** Null until a stage run reports usage. */
  costUsd: number | null;
  turns: number | null;
  startedAt: string;
  endedAt: string | null;
}

/** A file a stage run produced, e.g. a screenshot or the QA manifest. */
export interface Artifact {
  id: string;
  stageRunId: string;
  kind: ArtifactKind;
  path: string;
  label: string;
  sha256: string;
  createdAt: string;
}

export interface Approval {
  id: string;
  kind: TaskState;
  requested: Record<string, unknown>;
  decision: "approved" | "sent_back" | "answered" | null;
  reason: string | null;
  response: Record<string, unknown> | null;
  createdAt: string;
  decidedAt: string | null;
}

export interface TaskEvent {
  id: string;
  taskId: string;
  kind: string;
  payload: Record<string, unknown>;
  at: string;
}

/** `GET /tasks/:id` */
export interface TaskDetail {
  task: Task;
  stageRuns: StageRun[];
  approvals: Approval[];
  events: TaskEvent[];
  artifacts: Artifact[];
}

/**
 * Messages on `GET /events` (Server-Sent Events). The SSE `event` field is `type`.
 * - `task.updated`: a task changed; carries the whole task, so the board can just replace it.
 * - `task.event`: one entry from the task's activity log.
 * - `task.deleted`: the task is gone.
 */
export type StreamMessage =
  | { type: "task.updated"; task: Task }
  | { type: "task.event"; event: TaskEvent }
  | { type: "task.deleted"; id: string };

/** Error body for every 4xx and 5xx response. */
export interface ApiError {
  error: string;
  message: string;
}
