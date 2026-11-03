// `POST /tasks` as a work order: an Idempotency-Key makes a retry answer the task already made,
// and `start: true` starts the pipeline in the same call.
import type { DataSource } from "typeorm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { Pipeline } from "../../application/pipeline.ts";
import { StubStages } from "../../application/stages/stubs.ts";
import { freshTestDatabase } from "../../test/database.ts";
import { createApp } from "./app.ts";
import { Bus } from "./bus.ts";

let db: DataSource;
const stubs = new StubStages();
let pipeline: Pipeline;

beforeAll(async () => {
  db = await freshTestDatabase();
});
afterAll(async () => {
  await db.destroy();
});
beforeEach(async () => {
  await db.query("truncate tasks cascade");
  stubs.reset();
  pipeline = new Pipeline(db, stubs.runnerFor, { inline: true, hasConfig: () => true });
});

const order = {
  title: "Login page",
  criteria: ["Bad password shows an error"],
  source: { kind: "notch", ref: "LUNA-14", id: "8f1c0d7e-0000-0000-0000-000000000000", jiraKey: "PLAT-123" },
};
const post = async (body: unknown, key?: string) => {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (key !== undefined) headers["idempotency-key"] = key;
  const response = await createApp({ db, pipeline, bus: new Bus() }).request("/tasks", { method: "POST", body: JSON.stringify(body), headers });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};

describe("POST /tasks with an Idempotency-Key", () => {
  it("makes a new task on every call without a key, as before", async () => {
    expect((await post(order)).status).toBe(201);
    expect((await post(order)).status).toBe(201);
    expect(await pipeline.list()).toHaveLength(2);
  });

  it("answers the task already made, 200, for the same key and body, field order aside", async () => {
    const first = await post(order, "ticket-1:1");
    expect(first).toMatchObject({ status: 201, body: { title: "Login page", source: order.source } });
    const { title, ...rest } = order;
    const again = await post({ ...rest, title }, "ticket-1:1");
    expect(again).toMatchObject({ status: 200, body: { id: first.body.id } });
    expect(await pipeline.list()).toHaveLength(1);
    expect((await pipeline.events(String(first.body.id))).filter((e) => e.kind === "task.created")).toHaveLength(1);
  });

  it("is 409 idempotency_conflict for the same key with another body, and leaves the task as it was", async () => {
    const first = await post(order, "ticket-1:1");
    const other = await post({ ...order, title: "Logout page" }, "ticket-1:1");
    expect(other).toMatchObject({ status: 409, body: { error: "idempotency_conflict" } });
    expect((await pipeline.list()).map((t) => [t.id, t.title])).toEqual([[first.body.id, "Login page"]]);
  });

  it("makes one task when a retry races the first request", async () => {
    const answers = await Promise.all([post(order, "ticket-2:1"), post(order, "ticket-2:1"), post(order, "ticket-2:1")]);
    expect(answers.map((a) => a.status).sort()).toEqual([200, 200, 201]);
    expect(new Set(answers.map((a) => a.body.id)).size).toBe(1);
    expect(await pipeline.list()).toHaveLength(1);
  });

  it("keeps the key across a restart: a new machine over the same database answers the same task", async () => {
    const first = await post(order, "ticket-3:1");
    pipeline = new Pipeline(db, stubs.runnerFor, { inline: true, hasConfig: () => true });
    expect(await post(order, "ticket-3:1")).toMatchObject({ status: 200, body: { id: first.body.id } });
  });

  it("is 400 for an empty or overlong key", async () => {
    expect((await post(order, "")).status).toBe(400);
    expect((await post(order, "k".repeat(201))).status).toBe(400);
  });
});

describe("POST /tasks with start: true", () => {
  it("starts the pipeline at once, as POST /tasks/:id/start would", async () => {
    const made = await post({ ...order, start: true });
    expect(made).toMatchObject({ status: 201, body: { state: "awaiting_approval" } });
    expect((await pipeline.stageRuns(String(made.body.id))).map((r) => r.stage)).toEqual(["triage"]);
  });

  it("starts once: a retry answers the running task, and starts a task the first call left in Intake", async () => {
    const made = await post({ ...order, start: true }, "ticket-4:1");
    const again = await post({ ...order, start: true }, "ticket-4:1");
    expect(again).toMatchObject({ status: 200, body: { id: made.body.id, state: "awaiting_approval" } });
    expect(await pipeline.stageRuns(String(made.body.id))).toHaveLength(1);

    // The first call made the task and died before starting it: the retry starts it.
    const draft = await pipeline.createTaskOnce({ ...order, source: order.source as never, start: true }, "ticket-5:1");
    expect(draft.task.state).toBe("draft");
    expect(await post({ ...order, start: true }, "ticket-5:1")).toMatchObject({ status: 200, body: { id: draft.task.id, state: "awaiting_approval" } });
  });
});
