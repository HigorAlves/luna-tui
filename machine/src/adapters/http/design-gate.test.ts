import type { DataSource } from "typeorm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { Pipeline } from "../../application/pipeline.ts";
import { StubStages } from "../../application/stages/stubs.ts";
import { freshTestDatabase } from "../../test/database.ts";
import { PREVIEW_ON } from "../../test/policies.ts";
import { createApp } from "./app.ts";
import { Bus } from "./bus.ts";

let db: DataSource;
let stubs: StubStages;
let pipeline: Pipeline;
const truths: Array<{ name: string; body: Record<string, unknown> }> = [];

beforeAll(async () => {
  db = await freshTestDatabase();
});
afterAll(async () => {
  await db.destroy();
});

const finding = (id: string) => ({ id, path: "figma:F1/12:34", line: 0, severity: "should_fix", title: "Pay colour", body: "b", confidence: 0.9, category: "design", design: { source: "parity", frame: "F1", node: "12:34", element: "button.pay", kind: "token" } });
const design = { wcag: null, a11y: null, parity: { ran: true, runId: "r1-parity", confidence: 0.9, bar: 0.75, designInput: "complete", frames: [], counts: { blocker: 0, should_fix: 1, nit: 0, waived: 0 }, summary: "" }, findings: [finding("D1")], gate: { fires: true, why: ["open_findings"] } };
const app = () => createApp({ db, pipeline, bus: new Bus() });
const post = (path: string, body?: unknown) => app().request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });

beforeEach(async () => {
  await pipeline?.shutdown();
  await db.query("truncate tasks cascade");
  truths.length = 0;
  stubs = new StubStages();
  pipeline = new Pipeline(db, stubs.runnerFor, { inline: true, policies: { for: async () => PREVIEW_ON }, hasConfig: () => true, designTruth: async (_task, name, body) => (truths.push({ name, body: body as Record<string, unknown> }), `/gt/${name}`) });
});

async function atGate(): Promise<string> {
  stubs.plan("e2e", { outcome: "pass", detail: { step: "e2e", design } });
  const task = await pipeline.createTask({ title: "Checkout", criteria: ["pay works"] });
  await pipeline.start(task.id);
  await pipeline.decide(task.id, "approved");
  expect((await pipeline.get(task.id)).state).toBe("awaiting_design");
  return task.id;
}

describe("POST /tasks/:id/design/findings/:findingId/waive", () => {
  it("waives with a kind and a reason at the design gate", async () => {
    const id = await atGate();
    const res = await post(`/tasks/${id}/design/findings/D1/waive`, { kind: "accepted", reason: "brand allows it" });
    expect(res.status).toBe(200);
    expect(truths).toEqual([{ name: expect.stringContaining("D1"), body: expect.objectContaining({ kind: "accepted", reason: "brand allows it" }) }]);
    const gate = (await pipeline.approvals(id)).find((a) => a.decision === null)!;
    expect((gate.requested.design as { findings: Array<{ resolution?: unknown }> }).findings[0]!.resolution).toEqual({ status: "waived", by: "person" });
  });
  it("refuses a waiver without a reason (400), with a bad kind (400), and with one too short (400)", async () => {
    const id = await atGate();
    expect((await post(`/tasks/${id}/design/findings/D1/waive`, { kind: "accepted" })).status).toBe(400);
    expect((await post(`/tasks/${id}/design/findings/D1/waive`, { kind: "nope", reason: "fine, really" })).status).toBe(400);
    expect((await post(`/tasks/${id}/design/findings/D1/waive`, { kind: "accepted", reason: "ok" })).status).toBe(400);
    expect(truths).toEqual([]);
  });
  it("answers 404 for a finding the gate does not hold, and 409 anywhere but the gate", async () => {
    const id = await atGate();
    expect((await post(`/tasks/${id}/design/findings/nope/waive`, { kind: "accepted", reason: "fine, really" })).status).toBe(404);
    await pipeline.decide(id, "approved");
    expect((await post(`/tasks/${id}/design/findings/D1/waive`, { kind: "accepted", reason: "fine, really" })).status).toBe(409);
  });
});
