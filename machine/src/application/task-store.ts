// Everything Pipeline needs from storage. Every method here is plain CRUD except
// `withTaskLock`, whose Postgres implementation takes a row lock inside a transaction —
// the one seam where the transition engine's correctness depends on the storage layer.
import type { TaskRoute, TaskState } from "@hardness/contracts";

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
  /** A repo's own cap from its PIPELINE.md, over `maxPerRepo`. */
  repoCaps?: ReadonlyMap<string, number>;
  /** Tasks that may drive one stage at once; a stage not named has no cap. */
  maxPerStage?: Readonly<Record<string, number>>;
}

export interface TaskStore {
  createTask(input: NewTaskRow): Promise<TaskRow>;
  listTasks(): Promise<TaskRow[]>;
  getTask(id: string): Promise<TaskRow | null>;
  /** The task made from an issue (`github`) or a PR (`github_pr`) of this repo and number. */
  findTaskBySource(repo: string, number: number, kind?: "github" | "github_pr"): Promise<TaskRow | null>;
  updateTask(id: string, patch: Partial<TaskRow>): Promise<void>;
  deleteTask(id: string): Promise<void>;
  findStuckTasks(running: ReadonlySet<TaskState>): Promise<TaskRow[]>;
  /** Ends every stage run still `running` as aborted, except the ones a restart re-attached to. */
  markRunningStageRunsAborted(except?: readonly string[]): Promise<void>;
  /** The container's name and the commit it started from, known once the stage is under way. */
  markStageRunStarted(id: string, facts: { containerId: string; inputCommit: string | null }): Promise<void>;
  /** Finds the longest-queued task and claims it (clearing `queued`) under a row lock, so
   *  two slots freeing at once cannot both claim the same task. Null when none is queued. */
  claimNextQueuedTask(options: ClaimOptions): Promise<TaskRow | null>;

  /** Locks the task row for the rest of `fn`, so two transitions on the same task can never
   *  interleave. Throws `TaskNotFoundError`-shaped errors are the caller's job, not the
   *  store's — `fn` only ever sees a row that exists. */
  withTaskLock<T>(id: string, fn: (task: TaskRow, tx: TaskTx) => Promise<T>): Promise<T>;

  listStageRuns(taskId: string): Promise<StageRunRow[]>;
  /** What the task's stage runs have cost so far, in USD. */
  taskSpendUsd(taskId: string): Promise<number>;
  /** Spend and worked time per task, for the tasks that have any run; one query for a whole list. */
  usageByTask(): Promise<Map<string, TaskUsage>>;
  /** One task's spend and worked time. */
  taskUsage(taskId: string): Promise<TaskUsage>;
  /** What every stage run started since `since` has cost, in USD. */
  spendSinceUsd(since: Date): Promise<number>;
  /** What one repo's stage runs started since `since` have cost, in USD. */
  repoSpendSinceUsd(repoPath: string, since: Date): Promise<number>;
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
