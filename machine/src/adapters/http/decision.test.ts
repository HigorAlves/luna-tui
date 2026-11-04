// `POST /tasks/:id/decision` and who approved: a plan of High risk needs two distinct approvers; the
// gate shows 1 of 2 in between; the same name twice is a 409, a missing name a 400; any other plan
// approves at once, and the name is kept.
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

const decide = async (id: string, body: Record<string, unknown>) => {
  const response = await createApp({ db, pipeline, bus: new Bus() }).request(`/tasks/${id}/decision`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
};
const atPlanGate = async (level: "low" | "high") => {
  stubs.plan("test_design", { outcome: "pass", detail: { brief: "b", risk: { level, scores: {} } } });
  const task = await pipeline.createTask({ title: "Login" });
  await pipeline.start(task.id);
  return task.id;
};

describe("POST /tasks/:id/decision with an approver", () => {
  it("approves a plan of any other risk at once and keeps who approved", async () => {
    const id = await atPlanGate("low");
    const approved = await decide(id, { decision: "approved", approver: "ana" });
    expect(approved).toMatchObject({ status: 200, body: { state: "awaiting_ship" } });
    const gate = (await pipeline.approvals(id)).find((a) => a.kind === "awaiting_approval");
    expect(gate).toMatchObject({ decision: "approved", response: { approver: "ana" } });
    const bare = await atPlanGate("low");
    expect((await decide(bare, { decision: "approved" })).status).toBe(200);
  });

  it("keeps a High-risk gate open after the first name, showing 1 of 2, and closes it on a second, distinct name", async () => {
    const id = await atPlanGate("high");
    const first = await decide(id, { decision: "approved", approver: "ana" });
    expect(first).toMatchObject({ status: 200, body: { state: "awaiting_approval", gate: { state: "awaiting_approval", requested: { approvers: ["ana"] } } } });
    expect((await pipeline.events(id)).filter((e) => e.kind === "approval.partial").map((e) => e.payload)).toEqual([{ approver: "ana", needed: 2, have: 1 }]);
    expect((await pipeline.approvals(id)).find((a) => a.kind === "awaiting_approval")?.decision).toBeNull();

    const second = await decide(id, { decision: "approved", approver: "bo", reason: "looked at the rollback" });
    expect(second).toMatchObject({ status: 200, body: { state: "awaiting_ship" } });
    expect((await pipeline.approvals(id)).find((a) => a.kind === "awaiting_approval")).toMatchObject({
      decision: "approved",
      reason: "looked at the rollback",
      response: { approvers: ["ana", "bo"], approver: "bo" },
    });
  });

  it("refuses the same name twice (409 same_approver) and an approval with no name on a High-risk plan (400 approver_required)", async () => {
    const id = await atPlanGate("high");
    expect(await decide(id, { decision: "approved" })).toMatchObject({ status: 400, body: { error: "approver_required" } });
    await decide(id, { decision: "approved", approver: "ana" });
    expect(await decide(id, { decision: "approved", approver: "ana" })).toMatchObject({ status: 409, body: { error: "same_approver" } });
    expect((await pipeline.get(id)).state).toBe("awaiting_approval");
  });

  it("lets one person send a High-risk plan back, and never asks two names of a reply or an archive", async () => {
    const id = await atPlanGate("high");
    expect(await decide(id, { decision: "sent_back", approver: "ana", reason: "split it" })).toMatchObject({ status: 200 });
    stubs.plan("triage", { outcome: "pass", detail: { outcome: "archive", archiveReason: "duplicate", risk: { level: "high" } } });
    const other = await pipeline.createTask({ title: "dup" });
    await pipeline.start(other.id);
    expect(await decide(other.id, { decision: "approved" })).toMatchObject({ status: 200, body: { state: "archived" } });
  });
});
