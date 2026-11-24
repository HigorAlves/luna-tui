// The triage record and the evidence pack are jsonb columns on the task: written by createTask or
// updateTask, read back whole, null until something writes them.
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

const record = { source: "github", kind: "bug", goal: "Pressing j must not panic", size: "small", urgency: "normal", risk: "low" as const, signals: { kind: { answer: "bug", confidence: 0.91 } }, qa: [], decision: "plan" as const, reason: "clear repro", at: "2026-11-03T12:00:00.000Z", model: "typesafe/jev" };
const evidence = { summary: "no panic", format: "captures" as const, scenarios: [{ text: "j on an empty list", test: "empty_list_j", result: "pass" as const }], findings: [], outOfMap: [], risk: "low" as const, rollback: "revert", howToVerify: "cargo test", commitSha: "8cb5509", media: [], at: "2026-11-03T12:00:00.000Z" };

describe("task record and evidence", () => {
  it("are null on a new task, and updateTask persists each whole", async () => {
    const task = await store.createTask({ title: "t", description: "", criteria: [], repoPath: null, source: null });
    expect(task).toMatchObject({ record: null, evidence: null });
    await store.updateTask(task.id, { record });
    expect(await store.getTask(task.id)).toMatchObject({ record, evidence: null });
    await store.updateTask(task.id, { evidence });
    expect(await store.getTask(task.id)).toMatchObject({ record, evidence });
  });

  it("can be given when the task is created", async () => {
    const task = await store.createTask({ title: "t", description: "", criteria: [], repoPath: null, source: null, record });
    expect((await store.getTask(task.id))?.record).toEqual(record);
  });
});
