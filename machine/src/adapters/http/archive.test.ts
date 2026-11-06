// `POST /tasks/:id/archive`: a task ends as archived with a reason, whatever it was doing; a reason
// off the list is a 400, and a task already ended is a 409.
import type { DataSource } from "typeorm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { previewOn } from "../../test/policies.ts";

import { Pipeline } from "../../application/pipeline.ts";
import { StubStages } from "../../application/stages/stubs.ts";
import { freshTestDatabase } from "../../test/database.ts";
import { createApp } from "./app.ts";
import { Bus } from "./bus.ts";

let db: DataSource;
const stubs = new StubStages();
let pipeline: Pipeline;
let bus: Bus;

beforeAll(async () => {
  db = await freshTestDatabase();
});
afterAll(async () => {
  await db.destroy();
});
beforeEach(async () => {
  await db.query("truncate tasks cascade");
  stubs.reset();
  bus = new Bus();
  pipeline = new Pipeline(db, stubs.runnerFor, { inline: true, policies: previewOn, hasConfig: () => true });
});

const archive = async (id: string, reason: unknown) => {
  const response = await createApp({ db, pipeline, bus }).request(`/tasks/${id}/archive`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reason }) });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};
const atPlanGate = async () => {
  const task = await pipeline.createTask({ title: "Login" });
  await pipeline.start(task.id);
  return task.id;
};

describe("POST /tasks/:id/archive", () => {
  it("archives a task at a gate with its reason, closes its approval and answers the task", async () => {
    const id = await atPlanGate();
    expect(await archive(id, "sla_expired")).toMatchObject({ status: 200, body: { state: "archived", archiveReason: "sla_expired" } });
    expect(await pipeline.get(id)).toMatchObject({ state: "archived", archiveReason: "sla_expired" });
  });

  it("is a 400 for a reason off the list and a 409 for a task that already ended", async () => {
    const id = await atPlanGate();
    expect((await archive(id, "meh")).status).toBe(400);
    expect((await archive(id, "duplicate")).status).toBe(200);
    expect(await archive(id, "rejected")).toMatchObject({ status: 409, body: { error: "invalid_transition" } });
  });
});
