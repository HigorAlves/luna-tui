// Postgres implementation of the TaskStore port. Pure code motion from pipeline.ts: every
// query here is the same TypeORM call pipeline.ts used to make directly.
import type { TaskState } from "@hardness/contracts";
import type { DataSource } from "typeorm";
import { In, IsNull } from "typeorm";

import type {
  DecideApprovalInput,
  InsertStageRunInput,
  NewTaskRow,
  RecordEventInput,
  TaskStore,
  TaskTx,
  UpdateStageRunInput,
} from "../../application/task-store.ts";
import { type ApprovalRow, type ArtifactRow, type EventRow, type StageRunRow, type TaskRow, TaskNotFoundError } from "../../domain/task.ts";
import { NO_RETRIES } from "../../domain/transition.ts";
import { ApprovalEntity, ArtifactEntity, EventEntity, StageRunEntity, TaskEntity } from "./schemas.ts";

export class PgTaskStore implements TaskStore {
  constructor(private readonly db: DataSource) {}

  async createTask(input: NewTaskRow): Promise<TaskRow> {
    return this.db.getRepository(TaskEntity).save({
      title: input.title,
      description: input.description,
      criteria: input.criteria,
      repoPath: input.repoPath,
      source: input.source,
      branch: null,
      worktreePath: null,
      state: "backlog",
      retries: { ...NO_RETRIES },
      resumeTo: null,
      reason: null,
    });
  }

  listTasks(): Promise<TaskRow[]> {
    return this.db.getRepository(TaskEntity).find({ order: { createdAt: "ASC" } });
  }

  getTask(id: string): Promise<TaskRow | null> {
    return this.db.getRepository(TaskEntity).findOneBy({ id });
  }

  findTaskBySource(repo: string, number: number): Promise<TaskRow | null> {
    return this.db
      .getRepository(TaskEntity)
      .createQueryBuilder("task")
      .where("task.source->>'repo' = :repo", { repo })
      .andWhere("(task.source->>'number')::int = :number", { number })
      .getOne();
  }

  async updateTask(id: string, patch: Partial<TaskRow>): Promise<void> {
    await this.db.getRepository(TaskEntity).update({ id }, patch);
  }

  async deleteTask(id: string): Promise<void> {
    await this.db.getRepository(TaskEntity).delete({ id });
  }

  findStuckTasks(running: ReadonlySet<TaskState>): Promise<TaskRow[]> {
    return this.db
      .getRepository(TaskEntity)
      .find({ where: { state: In([...running]) }, order: { updatedAt: "ASC" } });
  }

  async markRunningStageRunsAborted(): Promise<void> {
    await this.db
      .getRepository(StageRunEntity)
      .update({ status: "running" }, { status: "aborted", endedAt: () => "clock_timestamp()" });
  }

  async claimOldestQueuedTask(): Promise<TaskRow | null> {
    // Pick a candidate unlocked, then re-check it under a row lock, so two slots freeing at
    // once cannot both claim the same queued task.
    const candidate = await this.db
      .getRepository(TaskEntity)
      .findOne({ where: { queued: true }, order: { updatedAt: "ASC" } });
    if (!candidate) return null;
    return this.db.transaction(async (tx) => {
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
  }

  async withTaskLock<T>(id: string, fn: (task: TaskRow, tx: TaskTx) => Promise<T>): Promise<T> {
    return this.db.transaction(async (manager) => {
      const task = await manager.findOne(TaskEntity, { where: { id }, lock: { mode: "pessimistic_write" } });
      if (!task) throw new TaskNotFoundError(id);

      const tx: TaskTx = {
        async updateTask(id, patch) {
          await manager.update(TaskEntity, { id }, patch);
        },
        findOpenApproval(taskId) {
          return manager.findOneBy(ApprovalEntity, { taskId, decision: IsNull() });
        },
        async decideApproval(open: ApprovalRow, decision: DecideApprovalInput) {
          await manager.save(ApprovalEntity, { ...open, ...decision, decidedAt: new Date() });
        },
        async updateApprovalRequested(open: ApprovalRow, requested: Record<string, unknown>) {
          await manager.save(ApprovalEntity, { ...open, requested });
        },
        async insertApproval(input) {
          await manager.save(ApprovalEntity, manager.create(ApprovalEntity, input));
        },
        recordEvent(input: RecordEventInput) {
          return manager.save(EventEntity, manager.create(EventEntity, input));
        },
      };
      return fn(task, tx);
    });
  }

  listStageRuns(taskId: string): Promise<StageRunRow[]> {
    return this.db.getRepository(StageRunEntity).find({ where: { taskId }, order: { startedAt: "ASC" } });
  }

  async taskSpendUsd(taskId: string): Promise<number> {
    const [row] = (await this.db.query("select coalesce(sum(cost_usd), 0) as usd from stage_runs where task_id = $1", [taskId])) as { usd: string }[];
    return Number(row?.usd ?? 0);
  }

  async spendSinceUsd(since: Date): Promise<number> {
    const [row] = (await this.db.query("select coalesce(sum(cost_usd), 0) as usd from stage_runs where started_at >= $1", [since])) as { usd: string }[];
    return Number(row?.usd ?? 0);
  }

  countStageRunAttempts(taskId: string, stage: TaskState): Promise<number> {
    return this.db.getRepository(StageRunEntity).countBy({ taskId, stage });
  }

  async insertStageRun(input: InsertStageRunInput): Promise<string> {
    const inserted = await this.db.getRepository(StageRunEntity).insert({
      ...input,
      status: "running",
      startedAt: () => "clock_timestamp()",
    });
    return String(inserted.identifiers[0]?.id);
  }

  async updateStageRun(id: string, patch: UpdateStageRunInput): Promise<void> {
    const { ended, ...rest } = patch;
    await this.db
      .getRepository(StageRunEntity)
      .update({ id }, { ...rest, ...(ended ? { endedAt: () => "clock_timestamp()" } : {}) });
  }

  listApprovals(taskId: string): Promise<ApprovalRow[]> {
    return this.db.getRepository(ApprovalEntity).find({ where: { taskId }, order: { createdAt: "ASC" } });
  }

  listArtifacts(taskId: string): Promise<ArtifactRow[]> {
    return this.db.getRepository(ArtifactEntity).find({ where: { taskId }, order: { createdAt: "ASC" } });
  }

  async insertArtifact(input: Omit<ArtifactRow, "id" | "createdAt">): Promise<void> {
    await this.db.getRepository(ArtifactEntity).insert(input);
  }

  listEvents(taskId: string): Promise<EventRow[]> {
    return this.db.getRepository(EventEntity).find({ where: { taskId }, order: { id: "ASC" } });
  }

  findFinishedEvents(taskId: string): Promise<EventRow[]> {
    return this.db
      .getRepository(EventEntity)
      .find({ where: { taskId, kind: "stage.finished" }, order: { id: "DESC" } });
  }

  recordEvent(input: RecordEventInput): Promise<EventRow> {
    return this.db.manager.save(EventEntity, this.db.manager.create(EventEntity, input));
  }
}
