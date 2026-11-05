// HTTP and SSE shapes between the machine and the board. Requests are validated with
// these schemas; responses follow the interfaces.
import { z } from "zod";

import type { Column, TaskState } from "./index.ts";
import type { PrSnapshot } from "./github.ts";
import type { SlackSnapshot } from "./slack.ts";
import type { JiraLink, TaskSla } from "./jira.ts";
import type { AgentPack, AgentRole, Pack } from "./packs.ts";
import { type CredentialOwner, EngineId } from "./engines.ts";
import type { ModelEntry, RuntimeId } from "./models.ts";
import { CardEntryFields } from "./card.ts";
import type { CardEventName } from "./card-events.ts";
import type { TaskReports } from "./reports.ts";
import { type ArtifactKind, PackId, StageEngines, StageOutcome, type TaskClassification, type TaskRoute, TaskSource, TestCase, ArchiveReason, type EvidencePack, type TriageRecord } from "./stage.ts";

export const NewTaskInput = z.object({
  title: z.string().trim().min(1),
  description: z.string().optional(),
  criteria: z.array(z.string().trim().min(1)).optional(),
  repoPath: z.string().nullable().optional(),
  source: TaskSource.nullable().optional(),
  /** Start the pipeline in the same call, as `POST /tasks/:id/start` would. */
  start: z.boolean().optional(),
  /** The engine per pack for this task, over the repo's luna.yaml and the pack's default. */
  stages: StageEngines.optional(),
  // The v2.2 entry contract (card.ts). Accepted and ignored in wave 8; wave 14 stores them.
  ...CardEntryFields,
});

/** The `create_card` entry contract of the v2.2 diagram: `NewTaskInput` with its optional sources,
 *  reporter, hints, origin machine and attachments. One schema, so a task created today parses as a card. */
export const CreateCardInput = NewTaskInput;
export type CreateCardInput = z.infer<typeof CreateCardInput>;

/** `PATCH /tasks/:id/stages`: the engine per pack to set; null goes back to luna.yaml's, else the pack's default. */
export const EditStagesInput = z.object({ stages: z.partialRecord(PackId, EngineId.nullable()) });
export type EditStagesInput = z.infer<typeof EditStagesInput>;

/** `POST /runs`: one context-only pack (it runs in no task state) on data the client sends.
 *  `context` holds the pack's own key of the stage input's context (`chat`, `issue`, `jira`,
 *  `slack`) and nothing else; the machine checks it against that key's schema. */
export const RunInput = z.object({
  pack: PackId,
  /** One of the pack's `engines.allowed`; absent means its default. */
  engine: EngineId.optional(),
  context: z.record(z.string(), z.unknown()),
});
export type RunInput = z.infer<typeof RunInput>;

/** What `POST /runs` answers: the pack's answer, validated against its schema, and what the run cost. */
export interface RunResult {
  answer: Record<string, unknown>;
  usage: { model: string; engine: EngineId; turns: number; durationMs: number; costUsd: number | null };
  /** The decision record this call left (a decision pack with records on), so a later fact can name it. Host use. */
  recordId?: string;
}

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

/** `PATCH /tasks/:id/plan`: edits triage's plan while it awaits your approval, or later at
 * the test check (nothing is built yet, so the approved plan may still move). Every field is
 * optional, but at least one must be given — the slices stay untouched either way. Each edit
 * appends a `PlanRevision` to the approval's `requested.revisions` instead of overwriting silently. */
export const EditPlanInput = z
  .object({
    brief: z.string().optional(),
    criteria: z.array(z.string()).optional(),
    assumptions: z.array(z.string()).optional(),
  })
  .refine((input) => Object.keys(input).length > 0, { message: "give at least one field to edit" });
export type EditPlanInput = z.infer<typeof EditPlanInput>;

/** One plan edit, kept on the approval's `requested.revisions`: only the fields that changed. */
export interface PlanRevision {
  at: string;
  before: EditPlanInput;
  after: EditPlanInput;
}

/** `PATCH /tasks/:id/cases`: replaces test_design's cases while the test check is open. */
export const EditCasesInput = z.object({
  cases: z.array(TestCase).min(1),
});
export type EditCasesInput = z.infer<typeof EditCasesInput>;

/** `GET /tasks/:id/diff`: the task branch against its base, one row per file; `patch` only with `?file=`. */
export interface TaskDiff {
  /** The merge base the branch is diffed against. */
  base: string;
  /** The worktree's HEAD. */
  head: string;
  files: TaskDiffFile[];
  /** The one file's patch; at most 512 KB of it. */
  patch?: string;
  /** Set when `patch` was cut at the cap. */
  truncated?: boolean;
}

export interface TaskDiffFile {
  path: string;
  status: "A" | "M" | "D" | "R";
  added: number;
  removed: number;
}

export const ArchiveInput = z.object({ reason: ArchiveReason });
export type ArchiveInput = z.infer<typeof ArchiveInput>;

export const DecisionInput = z.object({
  decision: z.enum(["approved", "sent_back"]),
  // Clients may send `null` for "no reason" rather than omitting the field.
  reason: z.string().nullable().optional(),
  /** At the memory review gate: false approves without writing the proposed rules. */
  applyRules: z.boolean().optional(),
  /** Who is deciding, by name. A plan of High risk needs two distinct names; any decision keeps its own. */
  approver: z.string().trim().min(1).max(100).optional(),
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
  /** Implementer runs taken on a stronger engine after a too_complex escalation. */
  stronger?: number;
  /** The next implementing run is that one shot. */
  strongerNext?: boolean;
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
  /** Why the task was archived; null for any other state. */
  archiveReason: ArchiveReason | null;
  /** What every stage run of this task has cost so far; null when unknown or nothing ran. */
  spentUsd: number | null;
  /** Wall time its stage runs took so far; null when unknown. */
  workedMs: number | null;
  /** The branch's diff against its base after the last writable run. */
  diff: { added: number; removed: number } | null;
  /** Verifying's results, passed over total, from its latest run. */
  tests: { passed: number; total: number } | null;
  /** The linked Jira issue, as the machine last saw it; null when the task has none. */
  jira: JiraLink | null;
  /** The ticket's SLA clocks, computed at snapshot time; null when none applies. */
  sla: TaskSla | null;
  /** The task's own engine per pack (`PATCH /tasks/:id/stages`); a pack left out runs on luna.yaml's, else its default. */
  stages: StageEngines;
  /** What triage_signals said about the issue the task came from; null when intake did not run it. */
  classification: TaskClassification | null;
  /** What triage decided and why; null before it ran. */
  record: TriageRecord | null;
  /** What shows the change does what the ticket asked; null before verifying made it. */
  evidence: EvidencePack | null;
  /** The task's place in the change sequence: every change to it takes a higher one (`GET /events?since=`). */
  seq: number;
  /** The latest stage run that ended, and what it said; null before one has. */
  lastRun: TaskLastRun | null;
  /** The gate the task waits at, with what it asks (the open approval's `requested`); null when it waits at none. */
  gate: TaskGate | null;
  createdAt: string;
  updatedAt: string;
}

/** The latest ended stage run on a task, as a snapshot carries it. */
export interface TaskLastRun {
  stage: TaskState;
  engine: EngineId | null;
  /** The stage's outcome (`pass`, `fail`, …), else how the run ended (`aborted`). */
  outcome: string | null;
  /** What it said: the pack's `summary`, else its error, else triage's `brief`; at most 2000 characters. */
  summary: string | null;
  /** When it ended. */
  at: string;
}

/** The open approval a task waits at. */
export interface TaskGate {
  state: TaskState;
  requested: Record<string, unknown>;
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
  /** Verifying only: one verdict per approved case, when the run reported them; null otherwise. */
  cases: StageRunCase[] | null;
  /** The engine the run started on; null for a host-only stage, or a run from before engines. */
  engine: EngineId | null;
  /** What the run's result named it ran on (RFC 0003 §7): its runtime, the pinned model ID, the
   *  SDK version and the fingerprint of the harness it ran. Null for a host-only stage, a run still
   *  going, or a run from before fingerprints. */
  runtime: string | null;
  modelId: string | null;
  sdkVersion: string | null;
  fingerprint: string | null;
  startedAt: string;
  endedAt: string | null;
}

export interface StageRunCase {
  title: string;
  ok: boolean;
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
  /** The v2.2 diagram's name(s) for the fact this row records; absent for a row the diagram has no name for. */
  names?: CardEventName[];
}

/** `GET /engines`: one row per engine, and whether this machine can run it. Never a credential's value. */
export interface EngineInfo {
  id: EngineId;
  runtime: RuntimeId;
  /** The pinned ID the runtime passes to its SDK. */
  modelId: string;
  /** How a run is paid for: Claude's subscription (its API key is the fallback), the Codex login, or an API key. */
  auth: "subscription" | "chatgpt" | "api-key";
  /** The catalog model's status. */
  status: ModelEntry["status"];
  /** This machine has the credential the engine needs. */
  available: boolean;
  /** What is missing, when it is not available. */
  reason?: string;
  /** This calendar month's recorded cost against the cap that binds the engine, else the engine's own. */
  spentThisMonthUsd: number;
  /** The machine's monthly cap that binds the engine (its own or its credential's, MACHINE_ENGINE_BUDGETS); null when none. */
  budgetUsd: number | null;
}

/** `GET /packs`: one row per pack in the registry. `kind` is `script` for a pack that calls no model,
 *  `decision` for one that asks a decision model typed questions (no role, no effort);
 *  `states` are the task states the pipeline runs it in (none for the inboxes' packs). */
export interface PackInfo {
  id: PackId;
  agent: AgentRole | null;
  kind: Pack["kind"];
  /** The engine the pack runs on unless a task names another, and the ones it may run on. */
  engines: Pack["engines"];
  effort: AgentPack["effort"] | null;
  writable: boolean;
  maxTurns: number;
  timeoutMs: number;
  states: TaskState[];
}

/** `GET /tasks/:id` */
export interface TaskDetail {
  task: Task;
  stageRuns: StageRun[];
  approvals: Approval[];
  events: TaskEvent[];
  artifacts: Artifact[];
  /** The v2.2 Build and Verify Reports, assembled from the task's runs and events; each null until its stage passed. */
  reports?: TaskReports;
}

/**
 * Messages on `GET /events` (Server-Sent Events). The SSE `event` field is `type`.
 * - `task.updated`: a task changed; carries the whole task, so the board can just replace it, and
 *   its `seq`, the cursor `GET /events?since=` replays from.
 * - `task.event`: one entry from the task's activity log.
 * - `task.deleted`: the task is gone; `seq` is its tombstone's place in the sequence.
 * - `task.metrics`: fresh factory metrics (7d window), sent after tasks change state.
 * - `stage.started`: a stage container is running; the board remembers it, so `f` can open a
 *   herdr tab at `cwd` labelled `label` that follows `container`'s logs, and points an
 *   already-open tab at it.
 * - `task.closed`: the task is done or deleted; the board closes its watch tab.
 * - `budget.alert`: a spend crossed 80, 90 or 100% of a ceiling (a task's, a repo's month's, the day's).
 * - `github.prs`: the PR inbox changed; carries the whole snapshot.
 * - `slack.items`: the Slack inbox changed; carries the whole snapshot, watches included.
 * - `task.shipped`: the task's PR merged; what shipped, where, and how to check it.
 */
export type StreamMessage =
  | { type: "task.updated"; task: Task; seq: number }
  | { type: "budget.alert"; alert: BudgetAlert }
  | { type: "task.event"; event: TaskEvent }
  | { type: "task.deleted"; id: string; seq: number }
  | { type: "task.metrics"; metrics: Metrics }
  | { type: "stage.started"; taskId: string; label: string; cwd: string; container: string }
  | { type: "task.closed"; id: string }
  | { type: "github.prs"; snapshot: PrSnapshot }
  | { type: "slack.items"; snapshot: SlackSnapshot }
  | { type: "task.shipped"; shipped: TaskShipped };

/** What `task.shipped` carries: the merged PR and the evidence behind it (web urls only). */
export interface TaskShipped {
  id: string;
  title: string;
  prUrl: string;
  number: number;
  mergedSha: string | null;
  format: string | null;
  howToVerify: string | null;
  media: { kind: string; label: string; url: string }[];
  at: string;
}

/** A spend passing a threshold of a ceiling; raised once per scope and threshold. */
export interface BudgetAlert {
  /** `engine`: a monthly cap per engine or credential (MACHINE_ENGINE_BUDGETS; with `repo`, that repo's luna.yaml `budget.engines`). */
  scope: "task" | "repo" | "day" | "engine";
  /** The task whose run crossed the line; null for a `POST /runs` call, which has none. */
  taskId: string | null;
  repo: string | null;
  /** The engine (`openai:sol`) or credential (`openai`) the cap names; only on `engine` alerts. */
  engine?: string;
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
  /** Each credential whose usage window a stage hit, and until when its queued work waits (ISO). Absent from older machines. */
  latched?: UsageLatch[];
}

/** One credential's usage window, latched: queued tasks whose next stage runs on it wait until `until`. */
export interface UsageLatch {
  owner: CredentialOwner;
  until: string;
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

/** One engine's stage runs in the window, for `GET /metrics?groupBy=engine`. */
export interface EngineMetrics {
  /** The engine the runs started on; null for host-only stages and runs from before engines. */
  engine: EngineId | null;
  stageRuns: number;
  /** Of the first attempts that passed or failed, the share that passed; null when there were none. */
  firstPassRate: number | null;
  /** Tasks that escalated in the window with a run on this engine as their latest before it. */
  escalations: number;
  /** Runs that ended on a usage limit. */
  rateLimited: number;
  /** Over the runs that passed or failed; null when none reported turns. */
  meanTurns: number | null;
  meanDurationMs: number | null;
  costUsd: number;
}

/** One fingerprint's slice of the window's stage runs, for `GET /metrics?groupBy=fingerprint`. */
export interface FingerprintMetrics {
  /** Null for runs from before fingerprints, and host-only stages. */
  fingerprint: string | null;
  /** Stage runs started in the window. */
  runs: number;
  /** Passed over passed and failed. */
  passRate: number | null;
  costUsd: number;
  /** Started to ended, for passed and failed runs. */
  durationMs: Stats;
  stages: string[];
  engines: string[];
}

/** What `GET /metrics?groupBy=` can add a row per: one switch, one `by…` list per value. */
export const METRICS_GROUP_BY = ["repo", "engine", "fingerprint"] as const;
export type MetricsGroupBy = (typeof METRICS_GROUP_BY)[number];

export interface Metrics {
  since: string;
  until: string;
  /** Set when the numbers are for one repo (`?repo=<path>`). */
  repo?: string | null;
  /** One row per repo, when asked for with `?groupBy=repo`. */
  byRepo?: RepoMetrics[];
  /** One row per engine, when asked for with `?groupBy=engine`: named engines first, then null. */
  byEngine?: EngineMetrics[];
  /** One row per fingerprint, when asked for with `?groupBy=fingerprint`. */
  byFingerprint?: FingerprintMetrics[];
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
  /** Gates answered within their SLA over gates answered, and the median wait per gate (ms). */
  gates: { withinSla: number | null; answered: number; waitMs: Record<string, Stats> };
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
  /** With 409 `idempotency_conflict`: the task the key already made. */
  taskId?: string;
  /** `POST /runs`' 429: when the engine's usage window resets (ISO), when the run said. */
  resetsAt?: string | null;
}
