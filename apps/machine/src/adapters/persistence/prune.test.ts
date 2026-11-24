import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DataSource } from "typeorm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { NO_RETRIES } from "../../domain/transition.ts";
import { freshTestDatabase } from "../../test/database.ts";
import { EventEntity, StageRunEntity, TaskEntity } from "./schemas.ts";
import { pruneOldRuns, prunePackRuns, pruneTombstones, TOMBSTONE_RETENTION_DAYS } from "./prune.ts";

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

  describe("run folders", () => {
    async function runFolder(stateDir: string, taskId: string): Promise<string> {
      const [row] = await db.getRepository(StageRunEntity).findBy({ taskId });
      const dir = join(stateDir, "runs", row!.id);
      mkdirSync(join(dir, "files"), { recursive: true });
      writeFileSync(join(dir, "files", "a.txt"), "x");
      return dir;
    }

    it("removes the folder of every pruned stage run, keeps a recent task's", async () => {
      const stateDir = mkdtempSync(join(tmpdir(), "prune-"));
      const oldId = await seedClosedTask(new Date(Date.now() - 100 * 24 * 60 * 60 * 1000));
      const recentId = await seedClosedTask(new Date());
      const oldDir = await runFolder(stateDir, oldId);
      const recentDir = await runFolder(stateDir, recentId);

      await pruneOldRuns(db, 90, stateDir);

      expect(existsSync(oldDir)).toBe(false);
      expect(existsSync(recentDir)).toBe(true);
      expect(await db.getRepository(StageRunEntity).findBy({ taskId: oldId })).toEqual([]);
    });

    it("removes the sub-run folders derived from a pruned run's id with it, and no other run's", async () => {
      const stateDir = mkdtempSync(join(tmpdir(), "prune-"));
      const oldId = await seedClosedTask(new Date(Date.now() - 100 * 24 * 60 * 60 * 1000));
      const recentId = await seedClosedTask(new Date());
      const oldDir = await runFolder(stateDir, oldId);
      const recentDir = await runFolder(stateDir, recentId);
      for (const dir of [oldDir, recentDir]) for (const suffix of ["-plan", "-tests-1"]) mkdirSync(`${dir}${suffix}`, { recursive: true });

      await pruneOldRuns(db, 90, stateDir);

      expect(existsSync(`${oldDir}-plan`)).toBe(false);
      expect(existsSync(`${oldDir}-tests-1`)).toBe(false);
      expect(existsSync(`${recentDir}-plan`)).toBe(true);
      expect(existsSync(`${recentDir}-tests-1`)).toBe(true);
    });

    it("tolerates a missing folder", async () => {
      const stateDir = mkdtempSync(join(tmpdir(), "prune-"));
      await seedClosedTask(new Date(Date.now() - 100 * 24 * 60 * 60 * 1000));
      await expect(pruneOldRuns(db, 90, stateDir)).resolves.toEqual({ events: 1, stageRuns: 1 });
    });

    it("removes nothing when retentionDays is 0", async () => {
      const stateDir = mkdtempSync(join(tmpdir(), "prune-"));
      const id = await seedClosedTask(new Date(Date.now() - 365 * 24 * 60 * 60 * 1000));
      const dir = await runFolder(stateDir, id);
      await pruneOldRuns(db, 0, stateDir);
      expect(existsSync(dir)).toBe(true);
    });
  });
});

describe("prunePackRuns", () => {
  it("deletes the pack_runs rows started more than `days` ago, keeps the rest, and is off at 0", async () => {
    await db.query("delete from pack_runs");
    const insert = (daysAgo: number) =>
      db.query(
        "insert into pack_runs (pack, engine, model, ok, turns, duration_ms, started_at, ended_at) values ('chat_triage', 'claude:haiku', 'm', true, 1, 10, now() - make_interval(days => $1), now() - make_interval(days => $1))",
        [daysAgo],
      );
    await insert(91);
    await insert(89);
    expect(await prunePackRuns(db, 0)).toBe(0);
    expect(await prunePackRuns(db, 90)).toBe(1);
    expect((await db.query("select count(*)::int as n from pack_runs"))[0].n).toBe(1);
  });
});

describe("pruneTombstones", () => {
  it(`deletes the tombstones of tasks deleted more than ${TOMBSTONE_RETENTION_DAYS} days ago and keeps the recent ones`, async () => {
    await db.query("delete from task_tombstones");
    const old = await seedClosedTask(new Date());
    const recent = await seedClosedTask(new Date());
    await db.query("delete from tasks where id in ($1, $2)", [old, recent]);
    await db.query("update task_tombstones set deleted_at = now() - make_interval(days => 31) where id = $1", [old]);
    expect(await pruneTombstones(db)).toBe(1);
    expect((await db.query("select id from task_tombstones")).map((r: { id: string }) => r.id)).toEqual([recent]);
  });
});
