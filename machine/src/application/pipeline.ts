// Applies engine transitions to Postgres and runs stages. Every transition happens in a
// transaction that locks the task row, so two requests cannot move one task at once, and
// a rejected event leaves no trace. Stages run in a background loop per task, so requests
// return as soon as the transition is stored.
import { type BudgetAlert, type Finding, RUNNING, type TaskSource, type TaskState } from "@hardness/contracts";
import type { DataSource } from "typeorm";

import type { RestartPolicy } from "../config.ts";
import type { TaskStore } from "./task-store.ts";
import { PgTaskStore } from "../adapters/persistence/task-store.ts";
import type { ApprovalRow, Decision, EventRow, StageRunRow, TaskRow } from "../domain/task.ts";
import { NoPlanToEditError, TaskBusyError, TaskNotFoundError } from "../domain/task.ts";
import { type PipelineEvent, type Step, transition } from "../domain/transition.ts";
import { branchDiffStat, removeWorktree as removeWorktreeOnDisk, revertCommit } from "../adapters/git/worktree.ts";
import { containerRunning, removeContainer } from "../adapters/docker/docker.ts";
import type { TaskUsage } from "./task-store.ts";
import { type CloseDeps, closeTask } from "./close-task.ts";
import type { StageResult, StageRunner } from "./ports.ts";
import type { Policy } from "../domain/policy.ts";
import { PolicyStore } from "./policy.ts";

export { NoPlanToEditError, TaskBusyError, TaskNotFoundError } from "../domain/task.ts";

/** A reset time as epoch seconds: the runner writes a number; older runners wrote a string (epoch or ISO). */
export function resetSeconds(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || value.trim() === "") return null;
  if (/^\d+(\.\d+)?$/.test(value.trim())) return Number(value);
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : Math.floor(parsed / 1000);
}

export interface NewTask {
  title: string;
  description?: string;
  criteria?: string[];
  repoPath?: string | null;
  source?: TaskSource | null;
}

export interface PipelineOptions {
  /** Called after each event is stored; the API streams these to the board. */
  onEvent?: (event: EventRow) => void;
  /** Run stages inside the request instead of in the background. Tests use this. */
  inline?: boolean;
  /** Tasks that can be driving a stage at once, across every repo. The rest queue. */
  maxConcurrentTasks?: number;
  /** Running tasks one repo may hold at once; null or absent means no cap. */
  maxPerRepo?: number | null;
  /** Tasks that may drive one stage at once, e.g. `{ implementing: 2 }`; a stage not named has no cap. */
  maxPerStage?: Record<string, number>;
  /** Whether a stage container is still running at boot; tests pass a fake. */
  containerRunning?: (name: string) => Promise<boolean>;
  /** Stops and removes a container recover() decided not to re-attach to; tests pass a fake. */
  removeContainer?: (name: string) => Promise<void>;
  /** Undoes one commit in a worktree; tests pass a fake. */
  revertCommit?: (worktreePath: string, sha: string) => Promise<void>;
  /** The branch's diff against its base, for the card; tests pass a fake. */
  diffStat?: (worktreePath: string, repoPath: string | null) => Promise<{ added: number; removed: number } | null>;
  /** What the close step needs once a task is approved for good. Without it, nothing is closed on the host. */
  closeDeps?: CloseDeps;
  /** Spend ceilings in USD; either unset means no ceiling of that kind. */
  budget?: Budget;
  /** On shutdown: `requeue` (default) parks running tasks for the next boot; `escalate` waits for you. */
  restartPolicy?: RestartPolicy;
  /** Each repo's luna.yaml (its monthly budget, auto-approval, concurrency); defaults when absent. */
  policies?: Pick<PolicyStore, "for">;
  /** Called once per threshold a scope crosses: 80, 90 and 100% of a task's, a repo's month's or the day's ceiling. */
  onAlert?: (alert: BudgetAlert) => void;
}

export type { BudgetAlert } from "@hardness/contracts";

const ALERT_STEPS: ReadonlyArray<80 | 90 | 100> = [80, 90, 100];

export interface Budget {
  /** Per task, over all its stage runs. Over it, the task escalates before its next stage. */
  taskUsd?: number | null;
  /** Over the trailing 24 hours. Over it, nothing is claimed and running tasks park between stages. */
  dailyUsd?: number | null;
}

const DAY_MS = 24 * 60 * 60_000;
const usd = (value: number) => `$${value.toFixed(2)}`;
/** The first instant of the current calendar month, local time. */
const monthStart = (now = new Date()) => new Date(now.getFullYear(), now.getMonth(), 1);
/** `2026-10`, the repo-month alert key. */
const monthKey = (now = new Date()) => `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
const dayKey = (now = new Date()) => now.toISOString().slice(0, 10);

interface DecisionRecord {
  decision: Decision;
  reason?: string;
  response?: Record<string, unknown>;
}

interface Extra {
  /** Stage output to keep, e.g. triage questions shown at the next gate. */
  detail?: Record<string, unknown>;
  /** Your answer to the gate the task is waiting at. */
  decision?: DecisionRecord;
}

/** A stage run a restart found still running in its container: drive it from where it is. */
interface Resume {
  runId: string;
  attempt: number;
  container: string;
  inputCommit: string | null;
}

/** Extra wait after a usage window's reset time before trying again. */
const RESUME_MARGIN_MS = 30_000;
/** A running task with no loop younger than this may be between its transition and its slot. */
const ORPHAN_GRACE_MS = 60_000;
/** How long abort() waits for the dying stage to let go of its slot before returning anyway. */
const ABORT_WIND_DOWN_MS = 15_000;
/** Identical consecutive failures of one stage before the stuck detector escalates. */
const STUCK_REPEATS = 3;
/** How long one rate-limit result holds every claim when it names no reset time. */
const LATCH_FALLBACK_MS = 5 * 60_000;

export class Pipeline {
  private readonly store: TaskStore;
  private readonly onEvent: (event: EventRow) => void;
  private readonly inline: boolean;
  private maxConcurrentTasks: number;
  /** Taking no new work: running stages finish, the queue waits. `drain()` / `resumeClaims()`. */
  private draining = false;
  private readonly maxPerRepo: number | null;
  private readonly maxPerStage: Record<string, number>;
  private readonly containerRunning: (name: string) => Promise<boolean>;
  private readonly removeContainer: (name: string) => Promise<void>;
  /** The stage each loop is driving right now, for the per-stage caps. */
  private readonly stages = new Map<string, TaskState>();
  /** Loops polling ci_watch: they hold no slot, so the pool is free for work that computes. */
  private readonly offPool = new Set<string>();
  private readonly revertCommit: (worktreePath: string, sha: string) => Promise<void>;
  private readonly diffStat: (worktreePath: string, repoPath: string | null) => Promise<{ added: number; removed: number } | null>;
  private readonly closeDeps: CloseDeps | undefined;
  readonly budget: Required<Budget>;
  private readonly restartPolicy: RestartPolicy;
  private readonly policies: Pick<PolicyStore, "for">;
  private readonly onAlert: (alert: BudgetAlert) => void;
  /** The highest threshold already raised per scope key (`task:<id>`, `repo:<path>:<month>`, `day:<date>`). */
  private readonly alerted = new Map<string, number>();
  /** Set by shutdown(): no slot is filled and no loop started from here on. */
  private stopping = false;
  /** The abort signal of each task currently driving a stage. Its size is the active count. */
  private readonly loops = new Map<string, AbortController>();
  private readonly resumeTimers = new Map<string, NodeJS.Timeout>();
  /** While set and in the future, no slot is claimed: one usage window is shared by every stage. */
  private latch: number | null = null;
  private supervisor: NodeJS.Timeout | undefined;

  constructor(
    db: DataSource,
    private readonly runnerFor: (stage: TaskState) => StageRunner,
    options: PipelineOptions = {},
  ) {
    this.store = new PgTaskStore(db);
    this.onEvent = options.onEvent ?? (() => {});
    this.inline = options.inline ?? false;
    this.maxConcurrentTasks = options.maxConcurrentTasks ?? 4;
    this.maxPerRepo = options.maxPerRepo ?? null;
    this.maxPerStage = options.maxPerStage ?? {};
    this.containerRunning = options.containerRunning ?? containerRunning;
    this.removeContainer = options.removeContainer ?? removeContainer;
    this.revertCommit = options.revertCommit ?? revertCommit;
    this.diffStat = options.diffStat ?? branchDiffStat;
    this.closeDeps = options.closeDeps;
    this.budget = { taskUsd: options.budget?.taskUsd ?? null, dailyUsd: options.budget?.dailyUsd ?? null };
    this.restartPolicy = options.restartPolicy ?? "requeue";
    this.policies = options.policies ?? new PolicyStore();
    this.onAlert = options.onAlert ?? (() => {});
  }

  /** The repo's policy, from its luna.yaml. */
  policyFor(repoPath: string | null): Promise<Policy> {
    return this.policies.for(repoPath);
  }

  /** What the repo has spent this calendar month, in USD. */
  private repoSpentThisMonthUsd(repoPath: string): Promise<number> {
    return this.store.repoSpendSinceUsd(repoPath, monthStart());
  }

  /** The repos that cannot start a stage right now: over their PIPELINE.md monthly ceiling.
   *  Only repos with a queued task are looked at, so an idle repo costs no query. */
  private async reposOverMonth(): Promise<Set<string>> {
    const over = new Set<string>();
    const queued = (await this.store.listTasks()).filter((t) => t.queued && t.repoPath);
    for (const repo of new Set(queued.map((t) => t.repoPath!))) {
      const { monthlyBudgetUsd } = await this.policies.for(repo);
      if (monthlyBudgetUsd !== null && (await this.repoSpentThisMonthUsd(repo)) >= monthlyBudgetUsd) over.add(repo);
    }
    return over;
  }

  /** What the trailing 24 hours have cost, in USD. */
  spentTodayUsd(): Promise<number> {
    return this.store.spendSinceUsd(new Date(Date.now() - DAY_MS));
  }

  /** True while the day's spend sits at or over its ceiling: no new stage should start. */
  private async dayOver(): Promise<boolean> {
    if (this.budget.dailyUsd === null) return false;
    return (await this.spentTodayUsd()) >= this.budget.dailyUsd;
  }

  async createTask(input: NewTask): Promise<TaskRow> {
    const task = await this.store.createTask({
      title: input.title,
      description: input.description ?? "",
      criteria: input.criteria ?? [],
      repoPath: input.repoPath ?? null,
      source: input.source ?? null,
    });
    await this.log(task.id, "task.created", { title: task.title });
    return this.get(task.id);
  }

  /** Stage slots: how many tasks may drive a stage at once, how many do right now, and
   *  whether the machine is draining (finishing what runs, claiming nothing new). */
  get slots(): { max: number; active: number; draining: boolean } {
    return { max: this.maxConcurrentTasks, active: this.active(), draining: this.draining };
  }

  /** Loops holding a slot: every stage loop but the ones polling ci_watch. */
  private active(): number {
    return this.loops.size - this.offPool.size;
  }

  /** True when `stage` already has its cap's worth of loops driving it (`id` itself not counted). */
  private stageAtCap(stage: TaskState, id: string): boolean {
    const cap = this.maxPerStage[stage];
    if (cap === undefined) return false;
    let held = 0;
    for (const [other, s] of this.stages) if (other !== id && s === stage && this.loops.has(other)) held++;
    return held >= cap;
  }

  /** "Stop picking up work, I'm leaving": running stages finish, queued tasks wait. */
  drain(): { max: number; active: number; draining: boolean } {
    this.draining = true;
    return this.slots;
  }

  /** Back to normal: the queue is picked up again at once. */
  resumeClaims(): { max: number; active: number; draining: boolean } {
    this.draining = false;
    void this.fillSlots().catch((error: unknown) => console.error("could not fill slots after resume", error));
    return this.slots;
  }

  /** Resizes the pool at run time; a bigger one fills from the queue at once, a smaller one
   *  lets running stages finish and claims nothing until the count fits. */
  setSlots(max: number): { max: number; active: number; draining: boolean } {
    if (!Number.isInteger(max) || max < 1) throw new Error(`slots must be at least 1, got ${max}`);
    this.maxConcurrentTasks = max;
    void this.fillSlots().catch((error: unknown) => console.error("could not fill slots after resize", error));
    return this.slots;
  }

  activeCount(): number {
    return this.active();
  }

  list(): Promise<TaskRow[]> {
    return this.store.listTasks();
  }

  /** Spend and worked time per task for every task that has a run, in one query. */
  usageByTask(): Promise<Map<string, TaskUsage>> {
    return this.store.usageByTask();
  }

  /** What one task has spent, and how long its runs took. */
  taskUsage(id: string): Promise<TaskUsage> {
    return this.store.taskUsage(id);
  }

  async get(id: string): Promise<TaskRow> {
    const task = await this.store.getTask(id);
    if (!task) throw new TaskNotFoundError(id);
    return task;
  }

  /** Logs a fact about a task from outside the engine (e.g. the thread it is reported in). */
  record(taskId: string, kind: string, payload: Record<string, unknown>): Promise<void> {
    return this.log(taskId, kind, payload);
  }

  /** The task created from this external issue, if any. */
  findBySource(repo: string, number: number): Promise<TaskRow | null> {
    return this.store.findTaskBySource(repo, number);
  }

  /** Edits the ticket's text. Stages started after this see the new text. */
  async update(
    id: string,
    patch: { title?: string; description?: string; criteria?: string[]; repoPath?: string | null;
      source?: TaskSource | null;
    },
  ): Promise<TaskRow> {
    await this.get(id);
    const changes = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
    if (Object.keys(changes).length > 0) {
      await this.store.updateTask(id, changes);
      await this.log(id, "task.edited", { fields: Object.keys(changes) });
    }
    return this.get(id);
  }

  /** Edits triage's proposed plan before you approve it: only the fields given change,
   *  the rest (including slices) stay as triage wrote them. */
  async editPlan(
    id: string,
    patch: { brief?: string; criteria?: string[]; assumptions?: string[] },
  ): Promise<TaskRow> {
    return this.store.withTaskLock(id, async (task, tx) => {
      const open = await tx.findOpenApproval(id);
      if (!open || open.kind !== "awaiting_approval") throw new NoPlanToEditError(id);
      const changes = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
      if (Object.keys(changes).length > 0) {
        await tx.updateApprovalRequested(open, { ...open.requested, ...changes });
      }
      return task;
    });
  }

  /** Deletes a task with its runs, approvals and events. Its worktree is kept. */
  /** Deletes the task and the checkout it worked in; the branch and its commits stay. */
  async delete(id: string): Promise<void> {
    const task = await this.get(id);
    if (RUNNING.has(task.state)) throw new TaskBusyError(id, task.state);
    clearTimeout(this.resumeTimers.get(id));
    this.resumeTimers.delete(id);
    if (task.repoPath && task.worktreePath) {
      await removeWorktreeOnDisk(task.repoPath, task.worktreePath).catch((error: unknown) =>
        console.error(`could not remove the worktree of deleted task ${id}`, error),
      );
    }
    await this.store.deleteTask(id);
  }

  /** Removes a task's worktree from disk once you are done with it. The task, its branch
   * and commits stay; only the checkout the agent worked in is gone. */
  async removeWorktree(id: string): Promise<TaskRow> {
    const task = await this.get(id);
    if (RUNNING.has(task.state)) throw new TaskBusyError(id, task.state);
    if (!task.repoPath || !task.worktreePath) return task;
    await removeWorktreeOnDisk(task.repoPath, task.worktreePath);
    await this.store.updateTask(id, { worktreePath: null });
    await this.log(id, "worktree.removed", { path: task.worktreePath });
    return this.get(id);
  }

  start(id: string): Promise<TaskRow> {
    return this.dispatch(id, { type: "start" });
  }

  answer(id: string, answers: Record<string, string>): Promise<TaskRow> {
    return this.dispatch(
      id,
      { type: "answered" },
      { decision: { decision: "answered", response: { answers } } },
    );
  }

  /** Approves or sends back whatever the task is waiting on, including an escalation. */
  decide(
    id: string,
    decision: "approved" | "sent_back",
    reason?: string,
    response?: Record<string, unknown>,
  ): Promise<TaskRow> {
    const event: PipelineEvent =
      decision === "approved" ? { type: "approved" } : { type: "sent_back" };
    return this.dispatch(id, event, { decision: { decision, reason, ...(response ? { response } : {}) } });
  }

  /** Stops the running (or merely queued) stage and waits for you. */
  async abort(id: string): Promise<TaskRow> {
    const task = await this.dispatch(id, { type: "abort" });
    this.loops.get(id)?.abort();
    await this.store.updateTask(id, { queued: false });
    clearTimeout(this.resumeTimers.get(id));
    this.resumeTimers.delete(id);
    // The task reads "escalated" from here on, but the stage is still dying: its container
    // being killed, its run recorded, its worktree reset. Return once that is over, so a
    // retry or a delete that follows this call never shares the worktree with a live container.
    if (!(await this.untilLoopEnds(id, ABORT_WIND_DOWN_MS))) return task;
    return (await this.store.getTask(id)) ?? task;
  }

  /** True once id's stage loop has let go of its slot, false if it has not within `ms`. */
  private async untilLoopEnds(id: string, ms: number): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (this.loops.has(id)) {
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return true;
  }

  /** Stops every running stage (killing its container) and waits for them to wind down, so a
   *  normal Ctrl+C does not leave a container or a dirty worktree running unseen. Under the
   *  `requeue` policy the tasks go back to the queue, state kept, and recover() re-runs the
   *  stage on the next boot; under `escalate` they wait for you, as an abort does. */
  async shutdown(): Promise<void> {
    this.stopping = true;
    this.stopSupervisor();
    const ids = [...this.loops.keys()];
    await Promise.all(
      ids.map((id) =>
        (this.restartPolicy === "requeue" ? this.park(id) : this.abort(id)).catch((error: unknown) =>
          console.error(`could not stop task ${id} on shutdown`, error),
        ),
      ),
    );
    const deadline = Date.now() + 5000;
    while (this.loops.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  /** Back to the queue with its state kept: the stage is cut short (its run ends `aborted`, the
   *  worktree reset as any failed attempt's is) and runs again from the top on the next boot. */
  private async park(id: string): Promise<void> {
    await this.enqueue(id);
    await this.log(id, "task.parked", { reason: "machine shutting down; the stage re-runs on the next boot" });
    this.loops.get(id)?.abort();
  }

  /** Epoch ms until which claims are held because a stage hit a usage limit; null when open. */
  get latchedUntil(): number | null {
    return this.latch !== null && this.latch > Date.now() ? this.latch : null;
  }

  /** Runs tick() every `intervalMs` until stopSupervisor(). */
  startSupervisor(intervalMs: number): void {
    this.stopSupervisor();
    this.supervisor = setInterval(() => {
      this.tick().catch((error: unknown) => console.error("supervisor tick failed", error));
    }, intervalMs);
    this.supervisor.unref();
  }

  stopSupervisor(): void {
    clearInterval(this.supervisor);
    this.supervisor = undefined;
  }

  /**
   * The supervisor: one periodic pass that catches what event-driven scheduling misses.
   * A running task nobody is driving is escalated (a crash that never reached the catch, a
   * restart, a lost claim); a paused task without a timer gets one back; then free slots
   * are filled from the queue, unless a usage window is latched.
   */
  async tick(): Promise<void> {
    const cutoff = Date.now() - ORPHAN_GRACE_MS;
    for (const task of await this.store.findStuckTasks(RUNNING)) {
      if (task.queued || this.loops.has(task.id) || task.updatedAt.getTime() > cutoff) continue;
      await this.apply(task.id, { type: "crash", error: "no stage loop was driving it" }, {}).catch((error: unknown) =>
        console.error(`could not escalate orphaned task ${task.id}`, error),
      );
    }
    await this.rearmPaused();
    await this.autoApprovePlans();
    await this.fillSlots();
  }

  /** A plan that has waited the repo's `auto_approve_plan_minutes` is approved by itself when
   *  triage reported high confidence and low risk and asked nothing. Anything less waits for you. */
  private async autoApprovePlans(): Promise<void> {
    for (const task of await this.store.findStuckTasks(new Set<TaskState>(["awaiting_approval"]))) {
      const { autoApprovePlanMinutes: minutes } = await this.policies.for(task.repoPath);
      if (minutes === null) continue;
      const open = (await this.store.listApprovals(task.id)).find((a) => a.kind === "awaiting_approval" && a.decision === null);
      if (!open) continue;
      const { confidence, risk, questions } = open.requested;
      if (confidence !== "high" || risk !== "low" || (Array.isArray(questions) && questions.length > 0)) continue;
      if (Date.now() - open.createdAt.getTime() < minutes * 60_000) continue;
      const reason = `auto-approved after ${minutes} min: triage reported high confidence and low risk`;
      await this.log(task.id, "plan.auto_approved", { reason });
      await this.decide(task.id, "approved", reason).catch((error: unknown) =>
        console.error(`could not auto-approve the plan of task ${task.id}`, error),
      );
    }
  }

  /** The usage window has reset: re-run the stage the task paused in. */
  windowReset(id: string): Promise<TaskRow> {
    clearTimeout(this.resumeTimers.get(id));
    this.resumeTimers.delete(id);
    // A reset, from the timer or from you, is the word that the window is open again.
    this.latch = null;
    return this.dispatch(id, { type: "window_reset" });
  }

  /**
   * After a restart no stage loop is running. A task that was actually mid-container-run
   * when the machine stopped is escalated, so you decide whether to re-run the stage; one
   * that was merely queued for a free slot lost nothing and is simply rescheduled.
   */
  async recover(): Promise<number> {
    const stuck = await this.store.findStuckTasks(RUNNING);
    // A stage container the last machine started may still be running: re-attach to it and
    // ingest its result when it ends, rather than kill it and ask you whether to start over.
    const resumable = new Map<string, StageRunRow>();
    for (const task of stuck) {
      if (task.queued) continue;
      const run = (await this.store.listStageRuns(task.id)).findLast((r) => r.status === "running" && r.stage === task.state);
      if (run?.containerId && (await this.containerRunning(run.containerId))) resumable.set(task.id, run);
    }
    await this.store.markRunningStageRunsAborted([...resumable.values()].map((r) => r.id));
    let escalated = 0;
    for (const task of stuck) {
      const run = resumable.get(task.id);
      if (task.queued) {
        await this.schedule(task.id, task.state);
      } else if (run) {
        const controller = this.reserveSlot(task.id, task.state);
        await this.log(task.id, "stage.reattached", { stage: task.state, container: run.containerId }, run.id);
        const loop = this.startLoop(task.id, task.state, controller, {
          runId: run.id,
          attempt: run.attempt,
          container: run.containerId!,
          inputCommit: run.inputCommit,
        });
        if (this.inline) await loop;
      } else {
        const dead = (await this.store.listStageRuns(task.id)).findLast((r) => r.stage === task.state && r.containerId);
        if (dead?.containerId) await this.removeContainer(dead.containerId).catch(() => {});
        await this.apply(task.id, { type: "abort" }, { detail: { note: "the machine restarted mid-stage" } });
        escalated++;
      }
    }
    await this.rearmPaused();
    return escalated;
  }

  /** Resume timers live in memory, so a restart during a usage window would otherwise park
   *  every paused task until someone clicks resume. Re-arm from the pause's own reset time. */
  private async rearmPaused(): Promise<void> {
    for (const task of await this.store.findStuckTasks(new Set<TaskState>(["paused_rate_limit"]))) {
      if (this.resumeTimers.has(task.id)) continue;
      const latest = (await this.store.findFinishedEvents(task.id))[0];
      const detail = latest?.payload.detail as Record<string, unknown> | undefined;
      const at = resetSeconds(detail?.resetsAt);
      if (at === null) continue;
      if (at * 1000 <= Date.now()) {
        await this.windowReset(task.id).catch((error: unknown) => console.error(`could not resume task ${task.id}`, error));
      } else {
        this.scheduleResume(task.id, at);
      }
    }
  }

  /** Claims queued tasks into free slots, oldest first, until the pool is full, the queue is
   *  empty, or a usage window is latched. The one place a slot is ever filled from the queue. */
  /** Into the queue, stamped: claims go by this time, so an edit while waiting keeps the place. */
  private enqueue(id: string): Promise<void> {
    return this.store.updateTask(id, { queued: true, queuedAt: new Date() });
  }

  private async fillSlots(): Promise<void> {
    while (!this.stopping && !this.draining && this.active() < this.maxConcurrentTasks && this.latchedUntil === null) {
      if (await this.dayOver()) return;
      const claimed = await this.store.claimNextQueuedTask({
        running: RUNNING,
        maxPerRepo: this.maxPerRepo,
        maxPerStage: this.maxPerStage,
        repoCaps: await this.repoCaps(),
        excludeRepos: await this.reposOverMonth(),
      });
      if (!claimed) return;
      const controller = this.reserveSlot(claimed.id, claimed.state);
      const loop = this.startLoop(claimed.id, claimed.state, controller);
      if (this.inline) await loop;
    }
  }

  /** Each queued repo's own cap from its PIPELINE.md, where it sets one. */
  private async repoCaps(): Promise<Map<string, number>> {
    const caps = new Map<string, number>();
    const queued = (await this.store.listTasks()).filter((t) => t.queued && t.repoPath);
    for (const repo of new Set(queued.map((t) => t.repoPath!))) {
      const { maxConcurrent } = await this.policies.for(repo);
      if (maxConcurrent !== null) caps.set(repo, maxConcurrent);
    }
    return caps;
  }

  stageRuns(id: string): Promise<StageRunRow[]> {
    return this.store.listStageRuns(id);
  }

  approvals(id: string): Promise<ApprovalRow[]> {
    return this.store.listApprovals(id);
  }

  artifacts(id: string): ReturnType<TaskStore["listArtifacts"]> {
    return this.store.listArtifacts(id);
  }

  events(id: string): Promise<EventRow[]> {
    return this.store.listEvents(id);
  }

  /** Applies an event and, if it starts a stage, runs it now or queues it for a free slot. */
  private async dispatch(id: string, event: PipelineEvent, extra: Extra = {}): Promise<TaskRow> {
    const step = await this.apply(id, event, extra);
    if (step.effect.kind === "run") {
      await this.schedule(id, step.effect.stage);
    }
    if (step.effect.kind === "done") await this.close(id);
    return this.get(id);
  }

  /** The memory review's proposal and whether the approval kept it, if the gate carried one. */
  private async approvedRules(id: string): Promise<{ markdown: string; apply: boolean } | undefined> {
    const gate = (await this.approvals(id)).filter((a) => a.kind === "reviewing_memory" && a.decision === "approved").at(-1);
    const rules = (gate?.requested as { rules?: { markdown?: unknown } } | undefined)?.rules;
    if (!gate || typeof rules?.markdown !== "string" || rules.markdown.trim() === "") return undefined;
    return { markdown: rules.markdown, apply: gate.response?.applyRules !== false };
  }

  /** Runs the host-side close step for a task that just closed and logs what it did. Never throws. */
  private async close(id: string): Promise<void> {
    if (!this.closeDeps) return;
    try {
      const task = await this.get(id);
      const report = await closeTask({ ...task, rules: await this.approvedRules(id) }, this.closeDeps);
      if (report.worktreeRemoved) {
        await this.store.updateTask(id, { worktreePath: null });
      }
      await this.log(id, "task.closed", { ...report });
    } catch (error) {
      console.error(`could not close task ${id}`, error);
    }
  }

  /**
   * Drives the stage now if a slot is free, otherwise marks the task queued for one. Always
   * waits for that decision (and the `queued` flag) to be stored before returning; only
   * waits for the whole run too in inline mode.
   */
  private async schedule(id: string, stage: TaskState): Promise<void> {
    if (this.stopping || this.draining || this.active() >= this.maxConcurrentTasks || this.latchedUntil !== null) {
      await this.enqueue(id);
      return;
    }
    // The slot is reserved before any await: two schedule() calls racing past the size check
    // above could otherwise both claim the last one. The checks that need the database come
    // after, and give the slot back when they hold the task.
    const controller = this.reserveSlot(id, stage);
    const release = () => {
      if (this.loops.get(id) === controller) this.loops.delete(id);
    };
    if (this.stageAtCap(stage, id)) {
      release();
      await this.enqueue(id);
      await this.log(id, "stage.held", { stage, reason: `${stage} is at its cap of ${this.maxPerStage[stage]}` });
      return;
    }
    try {
      if (await this.heldForDay(id, stage)) {
        release();
        return;
      }
      if (await this.repoAtCap(id)) {
        release();
        await this.enqueue(id);
        return;
      }
      // Clears a stale `queued: true` from before a restart, as well as the common case
      // where it was already false. Awaited here — not inside runAndFillSlot — so the
      // `queued` flag is guaranteed stored before schedule() returns, per its own contract;
      // otherwise recover() (which schedules a task that still reads queued:true) can race
      // a slot freeing elsewhere and have the same task claimed and driven a second time.
      await this.store.updateTask(id, { queued: false });
    } catch (error) {
      // Release the slot reserved above, or a transient failure on this update leaks it
      // for the rest of the process.
      release();
      throw error;
    }
    const loop = this.startLoop(id, stage, controller);
    if (this.inline) await loop;
  }

  /** True when the task's repo already holds its cap's worth of running tasks (the task itself
   *  not counted): the repo's own `max_concurrent` from PIPELINE.md, else `MACHINE_MAX_PER_REPO`. */
  private async repoAtCap(id: string): Promise<boolean> {
    const task = await this.store.getTask(id);
    if (!task) return false;
    const cap = (task.repoPath ? (await this.policies.for(task.repoPath)).maxConcurrent : null) ?? this.maxPerRepo;
    if (cap === null) return false;
    const running = await this.store.findStuckTasks(RUNNING);
    const held = running.filter((t) => t.id !== id && !t.queued && t.repoPath === task.repoPath && this.loops.has(t.id)).length;
    return held >= cap;
  }

  /** Creates and registers a new AbortController for `id` in `this.loops`, synchronously —
   *  before any `await` — so a slot this reserves can never be double-claimed by a
   *  concurrent schedule() call racing to check `this.loops.size` in between. The only path
   *  by which `this.loops` ever gains an entry; `startLoop` below is always paired with it. */
  private reserveSlot(id: string, stage: TaskState): AbortController {
    const controller = new AbortController();
    this.loops.set(id, controller);
    this.stages.set(id, stage);
    return controller;
  }

  /** Starts id's drive-then-promote loop. Not awaited outside inline mode — `.catch` logs a
   *  failure instead of letting it become an unhandled rejection that can crash the process. */
  private startLoop(id: string, stage: TaskState, controller: AbortController, resume?: Resume): Promise<void> {
    return this.runAndFillSlot(id, stage, controller, resume).catch((error: unknown) =>
      console.error(`run loop for task ${id} failed`, error),
    );
  }

  /** Drives the stage, then — once its slot is free again — starts the longest-queued task.
   *  `controller` is already registered in `this.loops` and the task's `queued` flag already
   *  cleared by the caller, synchronously, before any `await` — see schedule(). */
  private async runAndFillSlot(id: string, stage: TaskState, controller: AbortController, resume?: Resume): Promise<void> {
    await this.drive(id, stage, controller, resume);
    await this.fillSlots();
  }

  /** Runs stages one after another until the task waits on you, pauses, closes or is aborted.
   *  `controller` is already registered in `this.loops` by the caller. */
  private async drive(id: string, first: TaskState, controller: AbortController, resume?: Resume): Promise<void> {
    try {
      let stage: TaskState | null = first;
      while (stage) {
        this.stages.set(id, stage);
        if (await this.holdForBudget(id, stage)) return;
        // Another loop is already driving this stage at its cap: back to the queue, state kept;
        // the claim skips the stage until one of them moves on.
        if (!resume && this.stageAtCap(stage, id)) {
          await this.enqueue(id);
          await this.log(id, "stage.held", { stage, reason: `${stage} is at its cap of ${this.maxPerStage[stage]}` });
          return;
        }
        // ci_watch polls GitHub for up to 45 minutes and computes nothing: it gives its slot
        // back for that long, and the queue is looked at right away.
        const polling = stage === "ci_watch";
        if (polling) {
          this.offPool.add(id);
          this.fillSlots().catch((error: unknown) => console.error("could not fill slots during ci_watch", error));
        }
        let result: StageResult;
        try {
          result = await this.runStage(id, stage, controller.signal, resume);
        } finally {
          this.offPool.delete(id);
        }
        resume = undefined;
        // An abort already moved the task on; this stage's result no longer applies.
        if (controller.signal.aborted) return;
        const stuck = result.outcome === "fail" ? await this.stuckReason(id, stage) : null;
        // A test_change sends the task back to test_design; verifying's tests, the ones
        // implementing says are wrong, must not stay locked in the branch meanwhile.
        const revertFailed = stage === "implementing" && result.outcome === "test_change" ? await this.undoVerifyingTests(id) : null;
        const next: PipelineEvent = result.rateLimited
          ? { type: "rate_limited" }
          : (stuck ?? revertFailed)
            ? { type: "stage_done", outcome: "escalated", reason: (stuck ?? revertFailed)! }
            : {
                type: "stage_done",
                outcome: result.outcome,
                ...(typeof result.detail?.reason === "string" ? { reason: result.detail.reason } : {}),
              };
        const detail =
          result.needsInput?.length || result.requested?.length
            ? {
                ...result.detail,
                ...(result.needsInput?.length ? { questions: result.needsInput } : {}),
                ...(result.requested?.length ? { actions: result.requested } : {}),
              }
            : result.detail;
        const step = await this.apply(id, next, { detail });
        if (step.effect.kind === "pause") {
          this.scheduleResume(id, result.detail?.resetsAt);
          // One usage window is shared by every stage: hold claims until it resets, or the
          // whole queue would line up to hit the same wall.
          const at = resetSeconds(result.detail?.resetsAt);
          this.latch = Math.max(this.latch ?? 0, at !== null ? at * 1000 + RESUME_MARGIN_MS : Date.now() + LATCH_FALLBACK_MS);
        }
        stage = step.effect.kind === "run" ? step.effect.stage : null;
        // Back from polling with the pool now full: the next stage waits for a slot like any
        // queued task, and gets one as soon as a loop ends.
        if (stage && polling && this.active() > this.maxConcurrentTasks) {
          await this.enqueue(id);
          await this.log(id, "slot.waited", { stage, reason: "the pool filled while ci_watch was polling" });
          return;
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`stage loop for task ${id} stopped: ${message}`);
      await this.log(id, "loop.crashed", { error: message }).catch(() => {});
      // Leave the task where you can see it, not "running" with no loop behind it. Fails
      // quietly when the task already moved on (the crash came after its last transition).
      await this.apply(id, { type: "crash", error: message }, {}).catch(() => {});
    } finally {
      if (this.loops.get(id) === controller) {
        this.loops.delete(id);
        this.stages.delete(id);
      }
    }
  }

  /** Before a stage starts: over the task's own ceiling escalates it; over the day's parks it
   *  in the queue, state kept, for the supervisor to pick up once the window has moved on.
   *  True when the stage must not run. */
  private async holdForBudget(id: string, stage: TaskState): Promise<boolean> {
    const { taskUsd, dailyUsd } = this.budget;
    if (taskUsd !== null) {
      const spent = await this.store.taskSpendUsd(id);
      if (spent >= taskUsd) {
        await this.apply(id, { type: "over_budget", reason: `budget: task spent ${usd(spent)} of ${usd(taskUsd)}` }, {});
        return true;
      }
    }
    if (await this.heldForRepoMonth(id, stage)) return true;
    return this.heldForDay(id, stage);
  }

  /** Over the repo's monthly ceiling (its PIPELINE.md): the task waits in the queue, state
   *  kept, and the queue skips the repo until the month moves on or the ceiling is raised. */
  private async heldForRepoMonth(id: string, stage: TaskState): Promise<boolean> {
    const task = await this.store.getTask(id);
    if (!task?.repoPath) return false;
    const { monthlyBudgetUsd } = await this.policies.for(task.repoPath);
    if (monthlyBudgetUsd === null) return false;
    const spent = await this.repoSpentThisMonthUsd(task.repoPath);
    if (spent < monthlyBudgetUsd) return false;
    await this.enqueue(id);
    await this.log(id, "budget.held", { stage, reason: `budget: ${task.repoPath} spent ${usd(spent)} of ${usd(monthlyBudgetUsd)} this month` });
    return true;
  }

  /** After a run with a cost: each ceiling the spend has crossed a new threshold of, once. */
  private async raiseAlerts(id: string): Promise<void> {
    const task = await this.store.getTask(id);
    if (!task) return;
    const repo = task.repoPath;
    const raise = async (scope: BudgetAlert["scope"], key: string, limitUsd: number | null, spent: () => Promise<number>) => {
      if (limitUsd === null) return;
      const spentUsd = await spent();
      const reached = ALERT_STEPS.filter((pct) => spentUsd >= (limitUsd * pct) / 100);
      const highest = reached.at(-1);
      if (highest === undefined || highest <= (this.alerted.get(key) ?? 0)) return;
      this.alerted.set(key, highest);
      this.onAlert({ scope, taskId: id, repo, pct: highest, spentUsd: Math.round(spentUsd * 100) / 100, limitUsd });
    };
    await raise("task", `task:${id}`, this.budget.taskUsd, () => this.store.taskSpendUsd(id));
    if (repo) {
      const { monthlyBudgetUsd } = await this.policies.for(repo);
      await raise("repo", `repo:${repo}:${monthKey()}`, monthlyBudgetUsd, () => this.repoSpentThisMonthUsd(repo));
    }
    await raise("day", `day:${dayKey()}`, this.budget.dailyUsd, () => this.spentTodayUsd());
  }

  /** Over the day's ceiling: the task waits in the queue, state kept, and says why. */
  private async heldForDay(id: string, stage: TaskState): Promise<boolean> {
    const { dailyUsd } = this.budget;
    if (dailyUsd === null) return false;
    const spent = await this.spentTodayUsd();
    if (spent < dailyUsd) return false;
    await this.enqueue(id);
    await this.log(id, "budget.held", { stage, reason: `budget: ${usd(spent)} spent today of ${usd(dailyUsd)}` });
    return true;
  }

  /** True while a paused task has a resume timer armed. */
  hasResumeTimer(id: string): boolean {
    return this.resumeTimers.has(id);
  }

  /** Re-runs a paused stage shortly after its usage window resets. */
  private scheduleResume(id: string, resetsAt: unknown): void {
    const at = resetSeconds(resetsAt);
    // Without a reset time, `POST /tasks/:id/resume` continues the task.
    if (at === null) return;
    const delay = Math.max(0, at * 1000 - Date.now()) + RESUME_MARGIN_MS;
    clearTimeout(this.resumeTimers.get(id));
    const timer = setTimeout(() => {
      this.resumeTimers.delete(id);
      this.windowReset(id).catch((error: unknown) =>
        console.error(`could not resume task ${id}`, error),
      );
    }, delay);
    timer.unref();
    this.resumeTimers.set(id, timer);
  }

  private async apply(id: string, event: PipelineEvent, extra: Extra): Promise<Step> {
    const { step, logged } = await this.store.withTaskLock(id, async (task, tx) => {
      const step = transition(task, event);
      const open = extra.decision ? await tx.findOpenApproval(id) : null;
      // Approving the plan adopts triage's criteria: the ticket's, refined and added to.
      const planned = task.state === "awaiting_approval" && event.type === "approved" ? open?.requested.criteria : undefined;
      const criteria = Array.isArray(planned) && planned.length > 0 ? planned.map(String) : undefined;
      await tx.updateTask(id, {
        state: step.state,
        retries: step.retries,
        resumeTo: step.resumeTo,
        reason: step.reason ?? null,
        ...(criteria ? { criteria } : {}),
      });

      if (open && extra.decision) {
        await tx.decideApproval(open, {
          decision: extra.decision.decision,
          reason: extra.decision.reason ?? null,
          response: extra.decision.response ?? null,
        });
      }
      if (step.effect.kind === "wait") {
        await tx.insertApproval({
          taskId: id,
          kind: step.effect.gate,
          requested: { ...extra.detail, ...(step.reason ? { reason: step.reason } : {}) },
        });
      }

      const logged = await tx.recordEvent({
        taskId: id,
        kind: "transition",
        stageRunId: null,
        payload: {
          event: event.type,
          ...(event.type === "stage_done" ? { outcome: event.outcome } : {}),
          from: task.state,
          to: step.state,
          ...(step.reason ? { reason: step.reason } : {}),
        },
      });
      return { step, logged };
    });

    this.onEvent(logged);
    return step;
  }

  /** The latest finished run of a stage for a task, with the detail it ended with. */
  async latestStageFinish(id: string, stage: TaskState): Promise<{ runId: string; detail?: Record<string, unknown> } | null> {
    const finished = await this.store.findFinishedEvents(id);
    const latest = finished.find((event) => event.payload.stage === stage && event.stageRunId);
    if (!latest?.stageRunId) return null;
    const detail = latest.payload.detail;
    return {
      runId: latest.stageRunId,
      ...(detail && typeof detail === "object" ? { detail: detail as Record<string, unknown> } : {}),
    };
  }

  /** The card's numbers: the branch's diff after a writable pass, tests passed/total after verifying. */
  private async recordTriad(id: string, stage: TaskState, status: string, result: StageResult): Promise<void> {
    const patch: Partial<TaskRow> = {};
    if ((stage === "implementing" || stage === "verifying") && status === "passed" && result.workspace?.worktreePath) {
      const task = await this.store.getTask(id);
      const diff = await this.diffStat(result.workspace.worktreePath, task?.repoPath ?? null).catch(() => null);
      if (diff) Object.assign(patch, { diffAdded: diff.added, diffRemoved: diff.removed });
    }
    const results = (result.detail as { results?: unknown } | undefined)?.results;
    if (stage === "verifying" && Array.isArray(results)) {
      const passed = results.filter((r) => (r as { outcome?: string }).outcome === "pass").length;
      Object.assign(patch, { testsPassed: passed, testsTotal: results.length });
    }
    if (Object.keys(patch).length > 0) await this.store.updateTask(id, patch);
  }

  /** Reverts the commit the latest verifying run added (its tests), when it added one. Returns
   *  the escalation reason when the revert fails, else null. */
  private async undoVerifyingTests(id: string): Promise<string | null> {
    const runs = await this.store.listStageRuns(id);
    const verifying = runs.filter((r) => r.stage === "verifying" && r.outputCommit && r.outputCommit !== r.inputCommit).at(-1);
    const task = await this.store.getTask(id);
    if (!verifying?.outputCommit || !task?.worktreePath) return null;
    try {
      await this.revertCommit(task.worktreePath, verifying.outputCommit);
      await this.log(id, "tests.reverted", { commit: verifying.outputCommit, stageRunId: verifying.id });
      return null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `could not revert verifying's tests ${verifying.outputCommit}: ${message}`;
    }
  }

  /** The stuck detector's attempt-level rule: a stage that just failed for the third time in a
   *  row with the very same error is going nowhere; a human is cheaper than the rest of the
   *  retry cap. Returns the escalation reason, or null when the failures differ. */
  private async stuckReason(id: string, stage: TaskState): Promise<string | null> {
    const finished = await this.store.findFinishedEvents(id);
    const errors: string[] = [];
    for (const event of finished) {
      if (event.payload.stage !== stage) continue;
      if (event.payload.status !== "failed") break;
      const detail = event.payload.detail as { error?: unknown } | undefined;
      const error = typeof detail?.error === "string" ? detail.error.trim() : typeof event.payload.error === "string" ? event.payload.error.trim() : "";
      if (!error) break;
      errors.push(error);
      if (errors.length === STUCK_REPEATS) break;
    }
    if (errors.length < STUCK_REPEATS || new Set(errors).size !== 1) return null;
    return `stuck: ${stage} failed the same way ${STUCK_REPEATS} times: ${errors[0]}`;
  }

  /** The findings the latest verifying, ci_watch or failed implementing run stored on its
   *  `stage.finished` event. */
  private async latestVerifyingFindings(id: string): Promise<Finding[]> {
    const finished = await this.store.findFinishedEvents(id);
    // Whichever failed last is what the implementer is being re-run for: a red gate, or its
    // own previous attempt (e.g. it changed a locked test file and the commit was undone).
    const latest = finished.find(
      (event) =>
        event.payload.stage === "verifying" ||
        event.payload.stage === "ci_watch" ||
        (event.payload.stage === "implementing" && event.payload.status === "failed"),
    );
    // The pack runner reports findings at the result's top level; a stub or an older event
    // may carry them inside detail.
    const detail = latest?.payload.detail as { findings?: unknown } | undefined;
    const findings = latest?.payload.findings ?? detail?.findings;
    return Array.isArray(findings) ? (findings as Finding[]) : [];
  }

  private async runStage(id: string, stage: TaskState, signal: AbortSignal, resume?: Resume): Promise<StageResult> {
    // Re-attaching after a restart: the run row and its container already exist.
    const attempt = resume?.attempt ?? (await this.store.countStageRunAttempts(id, stage)) + 1;
    const runId = resume?.runId ?? (await this.store.insertStageRun({ taskId: id, stage, attempt }));
    if (!resume) await this.log(id, "stage.started", { stage, attempt }, runId);

    let result: StageResult;
    let error: string | undefined;
    try {
      const [task, approvals, priorFindings] = await Promise.all([
        this.get(id),
        this.approvals(id),
        stage === "implementing" ? this.latestVerifyingFindings(id) : Promise.resolve([]),
      ]);
      result = await this.runnerFor(stage)({
        task,
        stage,
        attempt,
        runId,
        approvals,
        priorFindings,
        signal,
        ...(resume ? { resume: { container: resume.container, inputCommit: resume.inputCommit } } : {}),
        started: (facts) => this.store.markStageRunStarted(runId, { containerId: facts.container, inputCommit: facts.inputCommit }),
      });
    } catch (thrown) {
      error = thrown instanceof Error ? thrown.message : String(thrown);
      result = { outcome: "fail" };
    }

    const status = signal.aborted
      ? "aborted"
      : result.rateLimited
        ? "paused"
        : result.outcome === "fail" || result.outcome === "escalated"
          ? "failed"
          : "passed";
    const outcome = result.rateLimited ? "rate_limited" : result.outcome;
    await this.store.updateStageRun(runId, {
      status,
      outcome,
      ended: true,
      // The container and input commit were stored when the stage started (`started`); a
      // result that names them again wins, one that does not leaves them be.
      ...(result.run?.containerId ? { containerId: result.run.containerId } : {}),
      ...(result.run?.inputCommit ? { inputCommit: result.run.inputCommit } : {}),
      transcriptPath: result.run?.transcriptPath ?? null,
      outputCommit: result.run?.outputCommit ?? null,
      ...(result.usage ? { turns: result.usage.turns, costUsd: result.usage.costUsd?.toString() ?? null } : {}),
    });
    if (result.usage?.costUsd) await this.raiseAlerts(id);
    for (const artifact of result.artifacts ?? []) {
      await this.store.insertArtifact({ taskId: id, stageRunId: runId, ...artifact });
    }
    for (const item of result.events ?? []) {
      const kind = item.kind.startsWith("stage.") ? item.kind : `stage.${item.kind}`;
      await this.log(id, kind, { ...item.payload, at: item.at }, runId);
    }
    if (result.workspace) {
      await this.store.updateTask(id, { branch: result.workspace.branch, worktreePath: result.workspace.worktreePath });
    }
    await this.recordTriad(id, stage, status, result);
    await this.log(
      id,
      "stage.finished",
      {
        stage,
        attempt,
        status,
        outcome,
        ...(error ? { error } : {}),
        ...(result.detail ? { detail: result.detail } : {}),
        // What the next implementing attempt is handed as prior findings (see latestVerifyingFindings).
        ...(result.findings?.length ? { findings: result.findings } : {}),
      },
      runId,
    );
    return result;
  }

  private async log(
    taskId: string,
    kind: string,
    payload: Record<string, unknown>,
    stageRunId: string | null = null,
  ): Promise<void> {
    this.onEvent(await this.store.recordEvent({ taskId, kind, payload, stageRunId }));
  }
}
