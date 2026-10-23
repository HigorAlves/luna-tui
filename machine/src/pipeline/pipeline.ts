// Applies engine transitions to Postgres and runs stages. Every transition happens in a
// transaction that locks the task row, so two requests cannot move one task at once, and
// a rejected event leaves no trace. Stages run in a background loop per task, so requests
// return as soon as the transition is stored.
import { RUNNING, type TaskSource, type TaskState } from "@hardness/contracts";
import { type DataSource, type EntityManager, In, IsNull } from "typeorm";

import {
  ApprovalEntity,
  type ApprovalRow,
  ArtifactEntity,
  type ArtifactRow,
  type Decision,
  EventEntity,
  type EventRow,
  StageRunEntity,
  type StageRunRow,
  type StageRunStatus,
  TaskEntity,
  type TaskRow,
} from "../db/entities.ts";
import { NO_RETRIES, type PipelineEvent, type Step, transition } from "../engine/transition.ts";
import { removeWorktree as removeWorktreeOnDisk } from "../git/worktree.ts";
import type { StageResult, StageRunner } from "../stages/runner.ts";

export class TaskNotFoundError extends Error {
  constructor(id: string) {
    super(`task ${id} not found`);
    this.name = "TaskNotFoundError";
  }
}

/** The task has a stage running, so it cannot be deleted until you abort it. */
export class TaskBusyError extends Error {
  constructor(id: string, state: TaskState) {
    super(`task ${id} is ${state}; abort it first`);
    this.name = "TaskBusyError";
  }
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
  private readonly onEvent: (event: EventRow) => void;
  private readonly inline: boolean;
  private readonly maxConcurrentTasks: number;
  /** The abort signal of each task currently driving a stage. Its size is the active count. */
  private readonly loops = new Map<string, AbortController>();
  private readonly resumeTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly db: DataSource,
    private readonly runnerFor: (stage: TaskState) => StageRunner,
    options: PipelineOptions = {},
  ) {
    this.onEvent = options.onEvent ?? (() => {});
    this.inline = options.inline ?? false;
    this.maxConcurrentTasks = options.maxConcurrentTasks ?? 4;
  }

  async createTask(input: NewTask): Promise<TaskRow> {
    const task = await this.db.getRepository(TaskEntity).save({
      title: input.title,
      description: input.description ?? "",
      criteria: input.criteria ?? [],
      repoPath: input.repoPath ?? null,
      source: input.source ?? null,
      branch: null,
      worktreePath: null,
      state: "backlog",
      retries: { ...NO_RETRIES },
      resumeTo: null,
      reason: null,
    });
    await this.log(task.id, "task.created", { title: task.title });
    return this.get(task.id);
  }

  /** The database, for read-only reports such as metrics. */
  get database(): DataSource {
    return this.db;
  }

  /** Stage slots: how many tasks may drive a stage at once, and how many do right now. */
  get slots(): { max: number; active: number } {
    return { max: this.maxConcurrentTasks, active: this.loops.size };
  }

  activeCount(): number {
    return this.loops.size;
  }

  list(): Promise<TaskRow[]> {
    return this.db.getRepository(TaskEntity).find({ order: { createdAt: "ASC" } });
  }

  async get(id: string): Promise<TaskRow> {
    const task = await this.db.getRepository(TaskEntity).findOneBy({ id });
    if (!task) throw new TaskNotFoundError(id);
    return task;
  }

  /** The task created from this external issue, if any. */
  async findBySource(repo: string, number: number): Promise<TaskRow | null> {
    return this.db
      .getRepository(TaskEntity)
      .createQueryBuilder("task")
      .where("task.source->>'repo' = :repo", { repo })
      .andWhere("(task.source->>'number')::int = :number", { number })
      .getOne();
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
      await this.db.getRepository(TaskEntity).update({ id }, changes);
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
    await this.db.getRepository(TaskEntity).delete({ id });
  }

  /** Removes a task's worktree from disk once you are done with it. The task, its branch
   * and commits stay; only the checkout the agent worked in is gone. */
  async removeWorktree(id: string): Promise<TaskRow> {
    const task = await this.get(id);
    if (RUNNING.has(task.state)) throw new TaskBusyError(id, task.state);
    if (!task.repoPath || !task.worktreePath) return task;
    await removeWorktreeOnDisk(task.repoPath, task.worktreePath);
    await this.db.getRepository(TaskEntity).update({ id }, { worktreePath: null });
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
  decide(id: string, decision: "approved" | "sent_back", reason?: string): Promise<TaskRow> {
    const event: PipelineEvent =
      decision === "approved" ? { type: "approved" } : { type: "sent_back" };
    return this.dispatch(id, event, { decision: { decision, reason } });
  }

  /** Stops the running (or merely queued) stage and waits for you. */
  async abort(id: string): Promise<TaskRow> {
    const task = await this.dispatch(id, { type: "abort" });
    this.loops.get(id)?.abort();
    await this.db.getRepository(TaskEntity).update({ id }, { queued: false });
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
    const stuck = await this.db
      .getRepository(TaskEntity)
      .find({ where: { state: In([...RUNNING]) }, order: { updatedAt: "ASC" } });
    await this.db
      .getRepository(StageRunEntity)
      .update({ status: "running" }, { status: "aborted", endedAt: () => "clock_timestamp()" });
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
    return this.db
      .getRepository(StageRunEntity)
      .find({ where: { taskId: id }, order: { startedAt: "ASC" } });
  }

  approvals(id: string): Promise<ApprovalRow[]> {
    return this.db
      .getRepository(ApprovalEntity)
      .find({ where: { taskId: id }, order: { createdAt: "ASC" } });
  }

  artifacts(id: string): Promise<ArtifactRow[]> {
    return this.db
      .getRepository(ArtifactEntity)
      .find({ where: { taskId: id }, order: { createdAt: "ASC" } });
  }

  events(id: string): Promise<EventRow[]> {
    return this.db.getRepository(EventEntity).find({ where: { taskId: id }, order: { id: "ASC" } });
  }

  /** Applies an event and, if it starts a stage, runs it now or queues it for a free slot. */
  private async dispatch(id: string, event: PipelineEvent, extra: Extra = {}): Promise<TaskRow> {
    const step = await this.apply(id, event, extra);
    if (step.effect.kind === "run") {
      await this.schedule(id, step.effect.stage);
    }
    return this.get(id);
  }

  /**
   * Drives the stage now if a slot is free, otherwise marks the task queued for one. Always
   * waits for that decision (and the `queued` flag) to be stored before returning; only
   * waits for the whole run too in inline mode.
   */
  private async schedule(id: string, stage: TaskState): Promise<void> {
    if (this.loops.size >= this.maxConcurrentTasks) {
      await this.db.getRepository(TaskEntity).update({ id }, { queued: true });
      return;
    }
    // Clears a stale `queued: true` from before a restart, as well as the common case
    // where it was already false.
    await this.db.getRepository(TaskEntity).update({ id }, { queued: false });
    const loop = this.runAndFillSlot(id, stage);
    if (this.inline) await loop;
  }

  /** Drives the stage, then — once its slot is free again — starts the longest-queued task. */
  private async runAndFillSlot(id: string, stage: TaskState): Promise<void> {
    await this.drive(id, stage);
    if (this.loops.size >= this.maxConcurrentTasks) return;
    // Pick a candidate unlocked, then re-check it under a row lock, so two slots freeing at
    // once cannot both claim the same queued task.
    const candidate = await this.db
      .getRepository(TaskEntity)
      .findOne({ where: { queued: true }, order: { updatedAt: "ASC" } });
    if (!candidate) return;
    const claimed = await this.db.transaction(async (tx) => {
      const locked = await tx
        .getRepository(TaskEntity)
        .createQueryBuilder("task")
        .where("task.id = :id", { id: candidate.id })
        .andWhere("task.queued = :queued", { queued: true })
        .setLock("pessimistic_write")
        .getOne();
      if (!locked) return null;
      await tx.update(TaskEntity, { id: locked.id }, { queued: false });
      return locked;
    });
    if (claimed) void this.runAndFillSlot(claimed.id, claimed.state);
  }

  /** Runs stages one after another until the task waits on you, pauses, closes or is aborted. */
  private async drive(id: string, first: TaskState): Promise<void> {
    const controller = new AbortController();
    this.loops.set(id, controller);
    try {
      let stage: TaskState | null = first;
      while (stage) {
        const result = await this.runStage(id, stage, controller.signal);
        // An abort already moved the task on; this stage's result no longer applies.
        if (controller.signal.aborted) return;
        const next: PipelineEvent = result.rateLimited
          ? { type: "rate_limited" }
          : { type: "stage_done", outcome: result.outcome };
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
    const { step, logged } = await this.db.transaction(async (tx) => {
      const task = await tx.findOne(TaskEntity, {
        where: { id },
        lock: { mode: "pessimistic_write" },
      });
      if (!task) throw new TaskNotFoundError(id);

      const step = transition(task, event);
      await tx.update(
        TaskEntity,
        { id },
        {
          state: step.state,
          retries: step.retries,
          resumeTo: step.resumeTo,
          reason: step.reason ?? null,
        },
      );

      const open = extra.decision
        ? await tx.findOneBy(ApprovalEntity, { taskId: id, decision: IsNull() })
        : null;
      if (open && extra.decision) {
        await tx.save(ApprovalEntity, {
          ...open,
          decision: extra.decision.decision,
          reason: extra.decision.reason ?? null,
          response: extra.decision.response ?? null,
          decidedAt: new Date(),
        });
      }
      if (step.effect.kind === "wait") {
        await tx.insert(ApprovalEntity, {
          taskId: id,
          kind: step.effect.gate,
          requested: { ...extra.detail, ...(step.reason ? { reason: step.reason } : {}) },
        });
      }

      const logged = await this.record(tx, id, "transition", {
        event: event.type,
        ...(event.type === "stage_done" ? { outcome: event.outcome } : {}),
        from: task.state,
        to: step.state,
        ...(step.reason ? { reason: step.reason } : {}),
      });
      return { step, logged };
    });

    this.onEvent(logged);
    return step;
  }

  private async runStage(id: string, stage: TaskState, signal: AbortSignal): Promise<StageResult> {
    const runs = this.db.getRepository(StageRunEntity);
    const attempt = (await runs.countBy({ taskId: id, stage })) + 1;
    // clock_timestamp() has microsecond precision, so runs keep their order.
    const inserted = await runs.insert({
      taskId: id,
      stage,
      attempt,
      status: "running",
      startedAt: () => "clock_timestamp()",
    });
    const runId = String(inserted.identifiers[0]?.id);
    await this.log(id, "stage.started", { stage, attempt }, runId);

    let result: StageResult;
    let error: string | undefined;
    try {
      const [task, approvals] = await Promise.all([this.get(id), this.approvals(id)]);
      result = await this.runnerFor(stage)({ task, stage, attempt, runId, approvals, signal });
    } catch (thrown) {
      error = thrown instanceof Error ? thrown.message : String(thrown);
      result = { outcome: "fail" };
    }

    const status: StageRunStatus = signal.aborted
      ? "aborted"
      : result.rateLimited
        ? "paused"
        : result.outcome === "fail"
          ? "failed"
          : "passed";
    const outcome = result.rateLimited ? "rate_limited" : result.outcome;
    await runs.update(
      { id: runId },
      {
        status,
        outcome,
        endedAt: () => "clock_timestamp()",
        containerId: result.run?.containerId ?? null,
        transcriptPath: result.run?.transcriptPath ?? null,
        inputCommit: result.run?.inputCommit ?? null,
        outputCommit: result.run?.outputCommit ?? null,
        ...(result.usage ? { turns: result.usage.turns, costUsd: result.usage.costUsd?.toString() ?? null } : {}),
      },
    );
    for (const artifact of result.artifacts ?? []) {
      await this.db.getRepository(ArtifactEntity).insert({ taskId: id, stageRunId: runId, ...artifact });
    }
    for (const item of result.events ?? []) {
      const kind = item.kind.startsWith("orc.") ? item.kind : `orc.${item.kind}`;
      await this.log(id, kind, { ...item.payload, at: item.at }, runId);
    }
    if (result.workspace) {
      await this.db
        .getRepository(TaskEntity)
        .update({ id }, { branch: result.workspace.branch, worktreePath: result.workspace.worktreePath });
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

  private record(
    manager: EntityManager,
    taskId: string,
    kind: string,
    payload: Record<string, unknown>,
    stageRunId: string | null = null,
  ): Promise<EventRow> {
    return manager.save(EventEntity, manager.create(EventEntity, { taskId, kind, payload, stageRunId }));
  }

  private async log(
    taskId: string,
    kind: string,
    payload: Record<string, unknown>,
    stageRunId: string | null = null,
  ): Promise<void> {
    this.onEvent(await this.record(this.db.manager, taskId, kind, payload, stageRunId));
  }
}
