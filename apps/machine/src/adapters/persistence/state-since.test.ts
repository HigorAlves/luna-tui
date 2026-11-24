import type { DataSource } from "typeorm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { NO_RETRIES } from "../../domain/transition.ts";
import { freshTestDatabase } from "../../test/database.ts";
import { AddTaskStateSince1793900000000 } from "./migrations/1793900000000-AddTaskStateSince.ts";
import { EventEntity, TaskEntity } from "./schemas.ts";

let db: DataSource;
beforeAll(async () => {
  db = await freshTestDatabase();
});
afterAll(async () => {
  await db.destroy();
});

describe("AddTaskStateSince", () => {
  it("backfills state_since from the latest transition event, or creation for a task that never moved", async () => {
    const runner = db.createQueryRunner();
    const migration = new AddTaskStateSince1793900000000();
    await migration.down(runner);
    const row = { title: "x", description: "", criteria: [], repoPath: null, branch: null, worktreePath: null, retries: { ...NO_RETRIES }, resumeTo: null, reason: null };
    const [moved] = (await db.query(`insert into tasks (title, description, criteria, retries, state) values ('moved', '', '[]', $1, 'awaiting_approval') returning id, created_at`, [JSON.stringify(row.retries)])) as { id: string; created_at: Date }[];
    const [still] = (await db.query(`insert into tasks (title, description, criteria, retries, state) values ('still', '', '[]', $1, 'draft') returning id, created_at`, [JSON.stringify(row.retries)])) as { id: string; created_at: Date }[];
    await db.query(`insert into events (task_id, kind, payload, at) values ($1, 'transition', '{"to":"triaging"}', '2026-10-28T10:00:00Z'), ($1, 'stage.finished', '{}', '2026-10-28T10:30:00Z'), ($1, 'transition', '{"to":"awaiting_approval"}', '2026-10-28T10:20:00Z')`, [moved!.id]);
    await migration.up(runner);
    await runner.release();
    const tasks = db.getRepository(TaskEntity);
    expect((await tasks.findOneByOrFail({ id: moved!.id })).stateSince?.toISOString()).toBe("2026-10-28T10:20:00.000Z");
    expect((await tasks.findOneByOrFail({ id: still!.id })).stateSince?.toISOString()).toBe(new Date(still!.created_at).toISOString());
    expect(await db.getRepository(EventEntity).countBy({ taskId: moved!.id })).toBe(3);
  });
});
