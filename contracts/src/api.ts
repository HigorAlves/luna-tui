// HTTP and SSE shapes between the machine and the board. Requests are validated with
// these schemas; responses follow the interfaces.
import { z } from "zod";

import type { Column, TaskState } from "./index.ts";
import type { PrSnapshot } from "./github.ts";
import { type ArtifactKind, StageOutcome, type TaskRoute, TaskSource } from "./stage.ts";

export const NewTaskInput = z.object({
  title: z.string().trim().min(1),
  description: z.string().optional(),
  criteria: z.array(z.string().trim().min(1)).optional(),
  repoPath: z.string().nullable().optional(),
  source: TaskSource.nullable().optional(),
});

/** `POST /repos/setup`: have the setup pack propose a luna.yaml for the checkout at `repoPath`. */
export const SetupRepoInput = z.object({ repoPath: z.string().trim().min(1) });
export type SetupRepoInput = z.infer<typeof SetupRepoInput>;
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

/** `PATCH /tasks/:id/plan`: edits triage's proposed plan before you approve it. Every
 * field is optional, but at least one must be given — the slices stay untouched either way. */
export const EditPlanInput = z
  .object({
    brief: z.string().optional(),
    criteria: z.array(z.string()).optional(),
    assumptions: z.array(z.string()).optional(),
  })
  .refine((input) => Object.keys(input).length > 0, { message: "give at least one field to edit" });
export type EditPlanInput = z.infer<typeof EditPlanInput>;

export const DecisionInput = z.object({
  decision: z.enum(["approved", "sent_back"]),
  // Clients may send `null` for "no reason" rather than omitting the field.
  reason: z.string().nullable().optional(),
  /** At the memory review gate: false approves without writing the proposed rules. */
  applyRules: z.boolean().optional(),
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
  /** The tracker item or PR this task came from, if any. */
  source: TaskSource | null;
  /** The graph the task walks; `feature` is the full pipeline. */
  route: TaskRoute;
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
  /** What every stage run of this task has cost so far; null when unknown or nothing ran. */
  spentUsd: number | null;
  /** Wall time its stage runs took so far; null when unknown. */
  workedMs: number | null;
  /** The branch's diff against its base after the last writable run. */
  diff: { added: number; removed: number } | null;
  /** Verifying's results, passed over total, from its latest run. */
  tests: { passed: number; total: number } | null;
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
 * - `task.metrics`: fresh factory metrics (7d window), sent after tasks change state.
 * - `stage.started`: a stage container is running; the board opens a herdr tab at `cwd`
 *   labelled `label` that follows `container`'s logs.
 * - `task.closed`: the task is done or deleted; the board closes its watch tab.
 * - `budget.alert`: a spend crossed 80, 90 or 100% of a ceiling (a task's, a repo's month's, the day's).
 * - `github.prs`: the PR inbox changed; carries the whole snapshot.
 */
export type StreamMessage =
  | { type: "task.updated"; task: Task }
  | { type: "budget.alert"; alert: BudgetAlert }
  | { type: "task.event"; event: TaskEvent }
  | { type: "task.deleted"; id: string }
  | { type: "task.metrics"; metrics: Metrics }
  | { type: "stage.started"; taskId: string; label: string; cwd: string; container: string }
  | { type: "task.closed"; id: string }
  | { type: "github.prs"; snapshot: PrSnapshot };

/** A spend passing a threshold of a ceiling; raised once per scope and threshold. */
export interface BudgetAlert {
  scope: "task" | "repo" | "day";
  /** The task whose run crossed the line. */
  taskId: string;
  repo: string | null;
  pct: 80 | 90 | 100;
  spentUsd: number;
  limitUsd: number;
}

/** Median and 90th percentile; null when there is no data. */
export interface Stats {
  median: number | null;
  p90: number | null;
}

/** `GET /metrics?since=<7d|30d|ISO>`. Numbers with no data are null, never NaN. */
/** The stage pool: size, in use, and whether the machine is draining. `GET /health`, `POST /drain`, `POST /resume` and `PATCH /slots` all answer with it. */
export interface Slots {
  max: number;
  active: number;
  draining: boolean;
}

/** One repo's slice of the window, for `GET /metrics?groupBy=repo`. */
export interface RepoMetrics {
  /** The checkout's path; null for tasks with no repo. */
  repo: string | null;
  tasks: Metrics["tasks"];
  escalationRate: number | null;
  firstPassVerifying: number | null;
  costUsd: number;
}

export interface Metrics {
  since: string;
  until: string;
  /** Set when the numbers are for one repo (`?repo=<path>`). */
  repo?: string | null;
  /** One row per repo, when asked for with `?groupBy=repo`. */
  byRepo?: RepoMetrics[];
  tasks: {
    created: number;
    closed: number;
    open: number;
    waitingOnYou: number;
    running: number;
    queued: number;
  };
  cycleTimeMs: {
    /** Created to closed, for tasks closed in the window. */
    task: Stats;
    /** Started to ended, for passed and failed stage runs started in the window. */
    perStage: Record<string, Stats & { runs: number }>;
  };
  /** Share of tasks whose first run of the stage passed. */
  firstPassRate: {
    verifying: number | null;
    ci_watch: number | null;
    implementing: number | null;
  };
  escalations: {
    /** Tasks that escalated at least once over tasks started in the window. */
    rate: number | null;
    topReasons: { reason: string; count: number }[];
  };
  retries: {
    perTask: Stats;
    byLoop: { verify: number; e2e: number; ci: number };
  };
  cost: {
    totalUsd: number;
    perTaskUsd: Stats;
    byStage: Record<string, number>;
  };
  queue: {
    depth: number;
    slots: Slots;
    utilisation: number | null;
  };
  /** Spend ceilings (null = none) and the trailing-24h spend the daily one applies to. */
  budget: {
    taskUsd: number | null;
    dailyUsd: number | null;
    spentTodayUsd: number;
    remainingTodayUsd: number | null;
  };
}

/** Error body for every 4xx and 5xx response. */
export interface ApiError {
  error: string;
  message: string;
}
