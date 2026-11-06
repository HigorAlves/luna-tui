// `POST /tasks/:id/abort`: a running stage stops for any task. At a gate only a Luna Notch task
// stops (its Stop button, RFC 0004): it goes to escalated as "stopped". A board task at a gate
// is a 409, as it always was.
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

beforeAll(async () => {
  db = await freshTestDatabase();
});
afterAll(async () => {
  await db.destroy();
});
beforeEach(async () => {
  await db.query("truncate tasks cascade");
  stubs.reset();
  pipeline = new Pipeline(db, stubs.runnerFor, { inline: true, policies: previewOn, hasConfig: () => true });
});

const notch = { kind: "notch", ref: "LUNA-14", id: "8f1c0d7e-0000-0000-0000-000000000000" } as const;
const abort = async (id: string) => {
  const response = await createApp({ db, pipeline, bus: new Bus() }).request(`/tasks/${id}/abort`, { method: "POST" });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};
const atPlanGate = async (source: typeof notch | null) => {
  const task = await pipeline.createTask({ title: "Login", source });
  await pipeline.start(task.id);
  expect((await pipeline.get(task.id)).state).toBe("awaiting_approval");
  return task.id;
};

describe("POST /tasks/:id/abort at a gate", () => {
  it("stops a notch task: escalated as stopped, the gate closed, and a retry runs triage again", async () => {
    const id = await atPlanGate(notch);
    expect(await abort(id)).toMatchObject({ status: 200, body: { state: "escalated", reason: "stopped", waitingOnYou: true } });
    const approvals = await pipeline.approvals(id);
    expect(approvals.map((a) => [a.kind, a.decision, a.reason])).toEqual([
      ["awaiting_approval", "sent_back", "stopped"],
      ["escalated", null, null],
    ]);
    stubs.plan("triage", { outcome: "pass" });
    expect((await pipeline.decide(id, "approved")).state).toBe("awaiting_approval");
  });

  it("stops a notch task waiting for answers too, but not one already escalated", async () => {
    stubs.plan("triage", { outcome: "needs_input", needsInput: [{ question: "q", recommended: "r" }] });
    const task = await pipeline.createTask({ title: "Login", source: notch });
    await pipeline.start(task.id);
    expect(await abort(task.id)).toMatchObject({ status: 200, body: { state: "escalated", reason: "stopped" } });
    expect(await abort(task.id)).toMatchObject({ status: 409, body: { error: "invalid_transition" } });
  });

  it("is still a 409 for a board task at a gate, which stays there", async () => {
    const id = await atPlanGate(null);
    expect(await abort(id)).toMatchObject({ status: 409, body: { error: "invalid_transition" } });
    expect(await pipeline.get(id)).toMatchObject({ state: "awaiting_approval" });
    expect((await pipeline.approvals(id)).map((a) => a.decision)).toEqual([null]);
  });
});
