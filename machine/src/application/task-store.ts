// Everything Pipeline needs from storage. Every method here is plain CRUD except
// `withTaskLock`, whose Postgres implementation takes a row lock inside a transaction —
// the one seam where the transition engine's correctness depends on the storage layer.
import type { CardFields, EngineId, JiraLink, StageEngines, StageRunCase, TaskClassification, TaskRoute, TaskState, EvidencePack, TriageRecord } from "@hardness/contracts";

import type { ApprovalRow, ArtifactRow, Decision, EventRow, StageRunRow, StageRunStatus, TaskRow } from "../domain/task.ts";

export interface NewTaskRow {
  title: string;
  description: string;
  criteria: string[];
  repoPath: string | null;
  source: TaskRow["source"];
  /** Defaults to `feature`. */
  route?: TaskRoute;
  /** A PR task starts on the PR's own branch, in a worktree prepared before the task exists. */
  branch?: string | null;
  worktreePath?: string | null;
  /** The Jira issue the task links to from the start (detected in its text, or its intake source). */
  jira?: JiraLink | null;
  /** The task's own engine per pack (the work order's `stages`). */
  stages?: StageEngines;
  /** What triage_signals said about the issue, when intake ran it. */
  classification?: TaskClassification | null;
  record?: TriageRecord | null;
  evidence?: EvidencePack | null;
  card?: CardFields | null;
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
  containerId?: string;
  transcriptPath: string | null;
  inputCommit?: string;
  outputCommit: string | null;
  turns?: number | null;
  costUsd?: string | null;
  cases?: StageRunCase[] | null;
  /** What the run's result named it ran on (domain/task.ts `runFacts`). */
  runtime?: string;
  modelId?: string;
  sdkVersion?: string;
  fingerprint?: string;
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
  /** The task's stage runs, read on the lock's own connection: another one, taken while the lock
   *  is held, could wait forever on a pool the lock's waiters have filled. */
  listStageRuns(taskId: string): Promise<StageRunRow[]>;
  /** The task's approvals, oldest first, read on the lock's own connection, for the same reason. */
  listApprovals(taskId: string): Promise<ApprovalRow[]>;
}

/** What a task's stage runs add up to: dollars, and wall time in them. */
export interface TaskUsage {
  spentUsd: number;
  workedMs: number;
}

/** How the next queued task is picked: oldest in the queue, the repo with the fewest running
 *  tasks first, never a repo at `maxPerRepo` (null: no cap). */
export interface ClaimOptions {
  running: ReadonlySet<TaskState>;
  maxPerRepo: number | null;
  /** Repos whose tasks stay queued for now (over their monthly budget). */
  excludeRepos?: ReadonlySet<string>;
  /** Tasks that stay queued for now (their next stage would spend a latched usage window). */
  excludeTasks?: ReadonlySet<string>;
  /** A repo's own cap from its PIPELINE.md, over `maxPerRepo`. */
  repoCaps?: ReadonlyMap<string, number>;
  /** Tasks that may drive one stage at once; a stage not named has no cap. */
  maxPerStage?: Readonly<Record<string, number>>;
}

/** What a task snapshot's `lastRun` and `gate` are made from. */
export interface GlanceRows {
  runs: Array<{ taskId: string; stage: TaskState; engine: EngineId | null; outcome: string | null; status: StageRunStatus; endedAt: Date; finished: Record<string, unknown> | null }>;
  gates: Array<{ taskId: string; kind: TaskState; requested: Record<string, unknown> }>;
}

/** One change past a sequence number: a task as it is now, or a task deleted since. */
export type TaskChange = { seq: number; task: TaskRow } | { seq: number; deleted: string };

export interface TaskStore {
  createTask(input: NewTaskRow): Promise<TaskRow>;
  /** Makes the task unless one already holds `key`, which it then answers instead; two calls
   *  racing on one key make one task. `created` says which happened. */
  createTaskOnce(input: NewTaskRow, key: string, requestHash: string): Promise<{ task: TaskRow; created: boolean }>;
  /** The task made under `key` by `createTaskOnce`, or null. */
  taskByKey(key: string): Promise<TaskRow | null>;
  listTasks(): Promise<TaskRow[]>;
  getTask(id: string): Promise<TaskRow | null>;
  /** The task made from an issue (`github`) or a PR (`github_pr`) of this repo and number. */
  findTaskBySource(repo: string, number: number, kind?: "github" | "github_pr"): Promise<TaskRow | null>;
  /** The latest task linked to a Jira issue, by its `jira` column, its intake source or a notch task's `jiraKey`. */
  findTaskByJiraKey(key: string): Promise<TaskRow | null>;
  updateTask(id: string, patch: Partial<TaskRow>): Promise<void>;
  /** Deletes the task; its tombstone's sequence number comes back. */
  deleteTask(id: string): Promise<number>;
  /** Every task changed and every task deleted after `since`, oldest first; `sourceKind` keeps one source's. */
  changesSince(since: number, sourceKind?: string | null): Promise<TaskChange[]>;
  /** The highest sequence number any committed change holds; 0 before the first. */
  lastSeq(): Promise<number>;
  findStuckTasks(running: ReadonlySet<TaskState>): Promise<TaskRow[]>;
  /** The cards that are not closed or archived and are stacked on this one (`card.base.card`). */
  findStackedOn(id: string): Promise<TaskRow[]>;
  /** Ends every stage run still `running` as aborted, except the ones a restart re-attached to. */
  markRunningStageRunsAborted(except?: readonly string[]): Promise<void>;
  /** The container's name and the commit it started from, known once the stage is under way. */
  markStageRunStarted(id: string, facts: { containerId: string; inputCommit: string | null; engine?: EngineId | null }): Promise<void>;
  /** Finds the longest-queued task and claims it (clearing `queued`) under a row lock, so
   *  two slots freeing at once cannot both claim the same task. Null when none is queued. */
  claimNextQueuedTask(options: ClaimOptions): Promise<TaskRow | null>;

  /** Locks the task row for the rest of `fn`, so two transitions on the same task can never
   *  interleave. Throws `TaskNotFoundError`-shaped errors are the caller's job, not the
   *  store's — `fn` only ever sees a row that exists. */
  withTaskLock<T>(id: string, fn: (task: TaskRow, tx: TaskTx) => Promise<T>): Promise<T>;

  listStageRuns(taskId: string): Promise<StageRunRow[]>;
  /** When the stage run still `running` started, per task that has one; one query for a whole list. */
  runningStageStarts(): Promise<Map<string, Date>>;
  /** Per task of `ids`: its latest ended stage run with that run's `stage.finished` payload, and its open approval. Two queries for a whole list. */
  glanceRows(ids: readonly string[]): Promise<GlanceRows>;
  /** What the task's stage runs have cost so far, in USD. */
  taskSpendUsd(taskId: string): Promise<number>;
  /** Spend and worked time per task, for the tasks that have any run; one query for a whole list. */
  usageByTask(): Promise<Map<string, TaskUsage>>;
  /** One task's spend and worked time. */
  taskUsage(taskId: string): Promise<TaskUsage>;
  /** What every stage run and `POST /runs` call (pack_runs) started since `since` has cost, in USD. */
  spendSinceUsd(since: Date): Promise<number>;
  /** What one repo's stage runs started since `since` have cost, in USD. */
  repoSpendSinceUsd(repoPath: string, since: Date): Promise<number>;
  /** Cost by engine since then: stage runs, `POST /runs` calls and Slack triage runs; with `repo`, that repo's stage runs only. */
  engineSpendSinceUsd(since: Date, repo?: string): Promise<Map<string, number>>;
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
