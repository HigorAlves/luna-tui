import type { DataSource } from "typeorm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { NO_RETRIES } from "../engine/transition.ts";
import { freshTestDatabase } from "../test/database.ts";
import { EventEntity, StageRunEntity, TaskEntity } from "./entities.ts";
import { pruneOldRuns } from "./prune.ts";

let db: DataSource;

beforeAll(async () => {
  db = await freshTestDatabase();
});

afterAll(async () => {
  await db.destroy();
});

beforeEach(async () => {
  await db.query("truncate tasks cascade");
});

async function seedClosedTask(updatedAt: Date): Promise<string> {
  const tasks = db.getRepository(TaskEntity);
  const task = await tasks.save({
    title: "x",
    description: "",
    criteria: [],
    repoPath: null,
    branch: null,
    worktreePath: null,
    state: "closed",
    retries: { ...NO_RETRIES },
    resumeTo: null,
    reason: null,
  });
  await db.getRepository(EventEntity).save({ taskId: task.id, kind: "task.created", payload: {} });
  await db
    .getRepository(StageRunEntity)
    .save({ taskId: task.id, stage: "triage", attempt: 1, status: "passed", outcome: "pass", startedAt: new Date() });
  // updated_at is a TypeORM @UpdateDateColumn-style column, set on save — backdate it directly.
  await db.query("update tasks set updated_at = $1 where id = $2", [updatedAt, task.id]);
  return task.id;
}

describe("pruneOldRuns", () => {
  it("removes events and stage runs for a closed task past the retention window, keeps the task", async () => {
    const old = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);
    const id = await seedClosedTask(old);

    const result = await pruneOldRuns(db, 90);

    expect(result).toEqual({ events: 1, stageRuns: 1 });
    expect(await db.getRepository(TaskEntity).findOneBy({ id })).not.toBeNull();
    expect(await db.getRepository(EventEntity).findBy({ taskId: id })).toEqual([]);
    expect(await db.getRepository(StageRunEntity).findBy({ taskId: id })).toEqual([]);
  });

  it("leaves a closed task inside the retention window alone", async () => {
    const recent = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000);
    const id = await seedClosedTask(recent);

    const result = await pruneOldRuns(db, 90);

    expect(result).toEqual({ events: 0, stageRuns: 0 });
    expect(await db.getRepository(EventEntity).findBy({ taskId: id })).toHaveLength(1);
  });

  it("never touches a task that isn't closed, however old", async () => {
    const tasks = db.getRepository(TaskEntity);
    const task = await tasks.save({
      title: "still open",
      description: "",
      criteria: [],
      repoPath: null,
      branch: null,
      worktreePath: null,
      state: "escalated",
      retries: { ...NO_RETRIES },
      resumeTo: null,
      reason: "stuck",
    });
    await db.getRepository(EventEntity).save({ taskId: task.id, kind: "task.created", payload: {} });
    await db.query("update tasks set updated_at = $1 where id = $2", [
      new Date(Date.now() - 365 * 24 * 60 * 60 * 1000),
      task.id,
    ]);

    const result = await pruneOldRuns(db, 90);

    expect(result).toEqual({ events: 0, stageRuns: 0 });
  });

  it("is a no-op when retentionDays is 0", async () => {
    const old = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
    await seedClosedTask(old);

    const result = await pruneOldRuns(db, 0);

    expect(result).toEqual({ events: 0, stageRuns: 0 });
  });
});
