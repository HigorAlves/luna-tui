// Applies engine transitions to Postgres and runs stages. Every transition happens in a
// transaction that locks the task row, so two requests cannot move one task at once, and
// a rejected event leaves no trace. Stages run in a background loop per task, so requests
// return as soon as the transition is stored.
import { type Finding, RUNNING, type TaskSource, type TaskState } from "@hardness/contracts";
import type { DataSource } from "typeorm";

import type { TaskStore } from "./task-store.ts";
import { PgTaskStore } from "../adapters/persistence/task-store.ts";
import type { ApprovalRow, Decision, EventRow, StageRunRow, TaskRow } from "../domain/task.ts";
import { TaskBusyError, TaskNotFoundError } from "../domain/task.ts";
import { type PipelineEvent, type Step, transition } from "../domain/transition.ts";
import { removeWorktree as removeWorktreeOnDisk } from "../adapters/git/worktree.ts";
import { type CloseDeps, closeTask } from "./close-task.ts";
import type { StageResult, StageRunner } from "./ports.ts";

export { TaskBusyError, TaskNotFoundError } from "../domain/task.ts";

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
  /** What the close step needs once a task is approved for good. Without it, nothing is closed on the host. */
  closeDeps?: CloseDeps;
}

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

/** Extra wait after a usage window's reset time before trying again. */
const RESUME_MARGIN_MS = 30_000;

export class Pipeline {
  private readonly store: TaskStore;
  private readonly onEvent: (event: EventRow) => void;
  private readonly inline: boolean;
  private readonly maxConcurrentTasks: number;
  private readonly closeDeps: CloseDeps | undefined;
  /** The abort signal of each task currently driving a stage. Its size is the active count. */
  private readonly loops = new Map<string, AbortController>();
  private readonly resumeTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    db: DataSource,
    private readonly runnerFor: (stage: TaskState) => StageRunner,
    options: PipelineOptions = {},
  ) {
    this.store = new PgTaskStore(db);
    this.onEvent = options.onEvent ?? (() => {});
    this.inline = options.inline ?? false;
    this.maxConcurrentTasks = options.maxConcurrentTasks ?? 4;
    this.closeDeps = options.closeDeps;
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

  /** Stage slots: how many tasks may drive a stage at once, and how many do right now. */
  get slots(): { max: number; active: number } {
    return { max: this.maxConcurrentTasks, active: this.loops.size };
  }

  activeCount(): number {
    return this.loops.size;
  }

  list(): Promise<TaskRow[]> {
    return this.store.listTasks();
  }

  async get(id: string): Promise<TaskRow> {
    const task = await this.store.getTask(id);
    if (!task) throw new TaskNotFoundError(id);
    return task;
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

  /** Deletes a task with its runs, approvals and events. Its worktree is kept. */
  async delete(id: string): Promise<void> {
    const task = await this.get(id);
    if (RUNNING.has(task.state)) throw new TaskBusyError(id, task.state);
    clearTimeout(this.resumeTimers.get(id));
    this.resumeTimers.delete(id);
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
    return task;
  }

  /** Aborts every running stage (killing its container) and waits for them to wind down,
   * so a normal Ctrl+C does not leave a container or a dirty worktree running unseen. */
  async shutdown(): Promise<void> {
    const ids = [...this.loops.keys()];
    await Promise.all(
      ids.map((id) =>
        this.abort(id).catch((error: unknown) => console.error(`could not abort task ${id} on shutdown`, error)),
      ),
    );
    const deadline = Date.now() + 5000;
    while (this.loops.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  /** The usage window has reset: re-run the stage the task paused in. */
  windowReset(id: string): Promise<TaskRow> {
    clearTimeout(this.resumeTimers.get(id));
    this.resumeTimers.delete(id);
    return this.dispatch(id, { type: "window_reset" });
  }

  /**
   * After a restart no stage loop is running. A task that was actually mid-container-run
   * when the machine stopped is escalated, so you decide whether to re-run the stage; one
   * that was merely queued for a free slot lost nothing and is simply rescheduled.
   */
  async recover(): Promise<number> {
    const stuck = await this.store.findStuckTasks(RUNNING);
    await this.store.markRunningStageRunsAborted();
    let escalated = 0;
    for (const task of stuck) {
      if (task.queued) {
        await this.schedule(task.id, task.state);
      } else {
        await this.apply(task.id, { type: "abort" }, { detail: { note: "the machine restarted mid-stage" } });
        escalated++;
      }
    }
    return escalated;
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
    if (this.loops.size >= this.maxConcurrentTasks) {
      await this.store.updateTask(id, { queued: true });
      return;
    }
    const controller = this.reserveSlot(id);
    try {
      // Clears a stale `queued: true` from before a restart, as well as the common case
      // where it was already false. Awaited here — not inside runAndFillSlot — so the
      // `queued` flag is guaranteed stored before schedule() returns, per its own contract;
      // otherwise recover() (which schedules a task that still reads queued:true) can race
      // a slot freeing elsewhere and have the same task claimed and driven a second time.
      await this.store.updateTask(id, { queued: false });
    } catch (error) {
      // Release the slot reserved above, or a transient failure on this update leaks it
      // for the rest of the process.
      if (this.loops.get(id) === controller) this.loops.delete(id);
      throw error;
    }
    const loop = this.startLoop(id, stage, controller);
    if (this.inline) await loop;
  }

  /** Creates and registers a new AbortController for `id` in `this.loops`, synchronously —
   *  before any `await` — so a slot this reserves can never be double-claimed by a
   *  concurrent schedule() call racing to check `this.loops.size` in between. The only path
   *  by which `this.loops` ever gains an entry; `startLoop` below is always paired with it. */
  private reserveSlot(id: string): AbortController {
    const controller = new AbortController();
    this.loops.set(id, controller);
    return controller;
  }

  /** Starts id's drive-then-promote loop. Not awaited outside inline mode — `.catch` logs a
   *  failure instead of letting it become an unhandled rejection that can crash the process. */
  private startLoop(id: string, stage: TaskState, controller: AbortController): Promise<void> {
    return this.runAndFillSlot(id, stage, controller).catch((error: unknown) =>
      console.error(`run loop for task ${id} failed`, error),
    );
  }

  /** Drives the stage, then — once its slot is free again — starts the longest-queued task.
   *  `controller` is already registered in `this.loops` and the task's `queued` flag already
   *  cleared by the caller, synchronously, before any `await` — see schedule(). */
  private async runAndFillSlot(id: string, stage: TaskState, controller: AbortController): Promise<void> {
    await this.drive(id, stage, controller);
    if (this.loops.size >= this.maxConcurrentTasks) return;
    const claimed = await this.store.claimOldestQueuedTask();
    if (claimed) {
      const nextController = this.reserveSlot(claimed.id);
      void this.startLoop(claimed.id, claimed.state, nextController);
    }
  }

  /** Runs stages one after another until the task waits on you, pauses, closes or is aborted.
   *  `controller` is already registered in `this.loops` by the caller. */
  private async drive(id: string, first: TaskState, controller: AbortController): Promise<void> {
    try {
      let stage: TaskState | null = first;
      while (stage) {
        const result = await this.runStage(id, stage, controller.signal);
        // An abort already moved the task on; this stage's result no longer applies.
        if (controller.signal.aborted) return;
        const next: PipelineEvent = result.rateLimited
          ? { type: "rate_limited" }
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
        if (step.effect.kind === "pause") this.scheduleResume(id, result.detail?.resetsAt);
        stage = step.effect.kind === "run" ? step.effect.stage : null;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`stage loop for task ${id} stopped: ${message}`);
      await this.log(id, "loop.crashed", { error: message }).catch(() => {});
    } finally {
      if (this.loops.get(id) === controller) this.loops.delete(id);
    }
  }

  /** Re-runs a paused stage shortly after its usage window resets. */
  private scheduleResume(id: string, resetsAt: unknown): void {
    // Without a reset time, `POST /tasks/:id/resume` continues the task.
    if (typeof resetsAt !== "number") return;
    const delay = Math.max(0, resetsAt * 1000 - Date.now()) + RESUME_MARGIN_MS;
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
      await tx.updateTask(id, {
        state: step.state,
        retries: step.retries,
        resumeTo: step.resumeTo,
        reason: step.reason ?? null,
      });

      const open = extra.decision ? await tx.findOpenApproval(id) : null;
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
    const detail = latest?.payload.detail as { findings?: unknown } | undefined;
    return Array.isArray(detail?.findings) ? (detail.findings as Finding[]) : [];
  }

  private async runStage(id: string, stage: TaskState, signal: AbortSignal): Promise<StageResult> {
    const attempt = (await this.store.countStageRunAttempts(id, stage)) + 1;
    const runId = await this.store.insertStageRun({ taskId: id, stage, attempt });
    await this.log(id, "stage.started", { stage, attempt }, runId);

    let result: StageResult;
    let error: string | undefined;
    try {
      const [task, approvals, priorFindings] = await Promise.all([
        this.get(id),
        this.approvals(id),
        stage === "implementing" ? this.latestVerifyingFindings(id) : Promise.resolve([]),
      ]);
      result = await this.runnerFor(stage)({ task, stage, attempt, runId, approvals, priorFindings, signal });
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
      containerId: result.run?.containerId ?? null,
      transcriptPath: result.run?.transcriptPath ?? null,
      inputCommit: result.run?.inputCommit ?? null,
      outputCommit: result.run?.outputCommit ?? null,
      ...(result.usage ? { turns: result.usage.turns, costUsd: result.usage.costUsd?.toString() ?? null } : {}),
    });
    for (const artifact of result.artifacts ?? []) {
      await this.store.insertArtifact({ taskId: id, stageRunId: runId, ...artifact });
    }
    for (const item of result.events ?? []) {
      const kind = item.kind.startsWith("orc.") ? item.kind : `orc.${item.kind}`;
      await this.log(id, kind, { ...item.payload, at: item.at }, runId);
    }
    if (result.workspace) {
      await this.store.updateTask(id, { branch: result.workspace.branch, worktreePath: result.workspace.worktreePath });
    }
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
