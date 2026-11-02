// Every task change takes the next number of one Postgres sequence, a deleted task leaves a
// tombstone with its own, and the numbers are handed out in commit order, so a reader that has
// seen N never later finds a committed change below N.
import type { DataSource } from "typeorm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { freshTestDatabase } from "../../test/database.ts";
import { PgTaskStore } from "./task-store.ts";

let db: DataSource;
let store: PgTaskStore;

beforeAll(async () => {
  db = await freshTestDatabase();
  store = new PgTaskStore(db);
});
afterAll(async () => {
  await db.destroy();
});
beforeEach(async () => {
  await db.query("truncate tasks, task_tombstones cascade");
});

const newTask = (title: string, source: Parameters<PgTaskStore["createTask"]>[0]["source"] = null) =>
  store.createTask({ title, description: "", criteria: [], repoPath: null, source });
const seqOf = async (id: string) => Number((await store.getTask(id))!.seq);

async function until(check: () => Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("the task sequence", () => {
  it("numbers each insert and update above every earlier change", async () => {
    const a = await newTask("a");
    const b = await newTask("b");
    const first = await seqOf(a.id);
    expect(await seqOf(b.id)).toBeGreaterThan(first);
    await store.updateTask(a.id, { title: "a2" });
    expect(await seqOf(a.id)).toBeGreaterThan(await seqOf(b.id));
  });

  it("leaves a tombstone with the next number and the task's source when a task is deleted", async () => {
    const source = { kind: "notch" as const, ref: "LUNA-1", id: "n-1" };
    const a = await newTask("a", source);
    const before = await seqOf(a.id);
    await store.deleteTask(a.id);
    const [tombstone] = (await db.query("select id, seq, source from task_tombstones")) as Array<{ id: string; seq: string; source: unknown }>;
    expect(tombstone).toMatchObject({ id: a.id, source });
    expect(Number(tombstone!.seq)).toBeGreaterThan(before);
  });

  it("hands numbers out in commit order: a change waits for an open one to commit and numbers after it", async () => {
    const a = await newTask("a");
    const b = await newTask("b");
    const open = db.createQueryRunner();
    await open.connect();
    await open.startTransaction();
    await open.query("update tasks set title = 'a2' where id = $1", [a.id]);
    const later = store.updateTask(b.id, { title: "b2" });
    await until(async () => {
      const [row] = (await db.query("select count(*)::int as n from pg_locks where locktype = 'advisory' and not granted")) as Array<{ n: number }>;
      return row!.n === 1;
    }, "the second change to wait on the first");
    await open.commitTransaction();
    await open.release();
    await later;
    expect(await seqOf(b.id)).toBeGreaterThan(await seqOf(a.id));
  });

  it("lists what changed after a number, tasks and tombstones in order, optionally of one source kind", async () => {
    const notch = { kind: "notch" as const, ref: "LUNA-1", id: "n-1" };
    const a = await newTask("a", notch);
    const since = await seqOf(a.id);
    await newTask("b");
    const c = await newTask("c", notch);
    await store.updateTask(a.id, { title: "a2" });
    await store.deleteTask(c.id);
    const all = await store.changesSince(since);
    expect(all.map((ch) => ("task" in ch ? ch.task.title : `deleted ${ch.deleted}`))).toEqual(["b", "a2", `deleted ${c.id}`]);
    expect(all.map((ch) => ch.seq)).toEqual([...all.map((ch) => ch.seq)].sort((x, y) => x - y));
    const mine = await store.changesSince(since, "notch");
    expect(mine.map((ch) => ("task" in ch ? ch.task.id : ch.deleted))).toEqual([a.id, c.id]);
    expect(await store.lastSeq()).toBe(all.at(-1)!.seq);
  });
});
