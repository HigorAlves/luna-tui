import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DataSource } from "typeorm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { DecisionTruth } from "../../application/decision-truth.ts";
import { Pipeline } from "../../application/pipeline.ts";
import { StubStages } from "../../application/stages/stubs.ts";
import { freshTestDatabase } from "../../test/database.ts";
import { PREVIEW_ON } from "../../test/policies.ts";
import { createApp } from "./app.ts";
import { Bus } from "./bus.ts";

let db: DataSource;
let stubs: StubStages;
let stateDir: string;
const learned: Array<[string, string, unknown]> = [];

beforeAll(async () => {
  db = await freshTestDatabase();
});
afterAll(async () => {
  await db.destroy();
});

const pack = (risk: "low" | "high") => ({ summary: "s", format: "text" as const, scenarios: [], findings: [], outOfMap: [], risk, rollback: "revert", howToVerify: "run it", commitSha: "9c1f0e2a7b3d", media: [], at: "2026-11-04T00:00:00.000Z" });
let pipeline: Pipeline;
const app = () => createApp({ db, pipeline, bus: new Bus() });
const post = (path: string, body?: unknown) => app().request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });

beforeEach(async () => {
  await db.query("truncate tasks cascade");
  learned.length = 0;
  stateDir = await mkdtemp(join(tmpdir(), "findings-"));
  stubs = new StubStages();
  const truth = new DecisionTruth({ setTruth: async (p, id, t) => (learned.push([p, id, t.label]), true), read: async () => ({ answer: {} }) as never }, { told: async () => {} });
  pipeline = new Pipeline(db, stubs.runnerFor, { inline: true, policies: { for: async () => PREVIEW_ON }, hasConfig: () => true, truth, retroOutputs: { stateDir, facts: async () => null } });
});

/** A card watched at awaiting_ship (no gate open) whose last Verify classified two findings. */
async function watched() {
  stubs.plan("verifying", { outcome: "pass", detail: { classified: [{ id: "f1", title: "t", classified: "blocker", recordId: "rec1" }, { id: "f2", title: "u", classified: "nit" }] } });
  const task = await pipeline.createTask({ title: "Login", criteria: ["x"], evidence: pack("low") });
  await pipeline.start(task.id);
  await pipeline.decide(task.id, "approved", undefined, undefined, { approver: "ana" });
  return task.id;
}

describe("the release question over HTTP", () => {
  it("answers 409 not_release_owner when a High-risk card is approved by someone the gate does not name", async () => {
    stubs.plan("awaiting_ship", { outcome: "needs_input", detail: { gate: "ship_approval", head: "h1", risk: "high", question: "safe to release now?", releaseOwners: ["bo"] } });
    const task = await pipeline.createTask({ title: "Billing", criteria: ["c"], evidence: pack("high") });
    await pipeline.start(task.id);
    await pipeline.decide(task.id, "approved", undefined, undefined, { approver: "ana" });
    await pipeline.decide(task.id, "approved");
    const res = await post(`/tasks/${task.id}/decision`, { decision: "approved", approver: "dee" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "not_release_owner" });
    expect((await pipeline.get(task.id)).state).toBe("awaiting_ship");
  });
});

describe("a dismissed or added finding", () => {
  it("dismisses a finding Verify reported: logs finding.dismissed with the id only, and labels the classification record a nit", async () => {
    const id = await watched();
    expect((await pipeline.get(id)).state).toBe("awaiting_ship");
    const res = await post(`/tasks/${id}/findings/f1/dismiss`, { reason: "not a real problem" });
    expect(res.status).toBe(200);
    const row = (await pipeline.events(id)).find((e) => e.kind === "finding.dismissed");
    expect(row?.payload).toEqual({ id: "f1" });
    expect(learned).toEqual([["finding_classify", "rec1", { severity: { choice: "nit" } }]]);
  });

  it("keeps the dismissal reason (through safe, capped) in the ground truth file and never on the event stream", async () => {
    const id = await watched();
    const reason = `not <b>real</b> ${"y".repeat(600)}`.slice(0, 500);
    expect((await post(`/tasks/${id}/findings/f1/dismiss`, { reason })).status).toBe(200);
    const file = JSON.parse(await readFile(join(stateDir, "ground-truth", "verify", `${id}.json`), "utf8"));
    expect(file.dismissed[0]).toMatchObject({ id: "f1" });
    expect(file.dismissed[0].reason).toContain("not");
    expect(file.dismissed[0].reason).not.toContain("<b>");
    expect(file.dismissed[0].reason.length).toBeLessThanOrEqual(300);
    expect(JSON.stringify(await pipeline.events(id))).not.toContain("not real");
    expect((await post(`/tasks/${id}/findings/f2/dismiss`, {})).status).toBe(200);
    const again = JSON.parse(await readFile(join(stateDir, "ground-truth", "verify", `${id}.json`), "utf8"));
    expect(again.dismissed).toHaveLength(2);
    expect(again.dismissed[1].reason).toBeUndefined();
  });

  it("is 404 for an id the last Verify did not report, and 409 when the card is not at awaiting_ship", async () => {
    const id = await watched();
    expect((await post(`/tasks/${id}/findings/zzz/dismiss`, {})).status).toBe(404);
    const idle = await pipeline.createTask({ title: "Idle" });
    expect((await post(`/tasks/${idle.id}/findings/f1/dismiss`, {})).status).toBe(409);
  });

  it("caps the reason at 500 characters", async () => {
    const id = await watched();
    expect((await post(`/tasks/${id}/findings/f1/dismiss`, { reason: "x".repeat(501) })).status).toBe(400);
  });

  it("adds a finding: logs finding.added with the severity only, and keeps the text (through safe) in the ground truth file", async () => {
    const id = await watched();
    const res = await post(`/tasks/${id}/findings`, { title: "missing <b>check</b>", severity: "should_fix", path: "src/a.ts", line: 3 });
    expect(res.status).toBe(200);
    expect((await pipeline.events(id)).find((e) => e.kind === "finding.added")?.payload).toEqual({ severity: "should_fix" });
    const file = JSON.parse(await readFile(join(stateDir, "ground-truth", "verify", `${id}.json`), "utf8"));
    expect(file.added[0]).toMatchObject({ severity: "should_fix", path: "src/a.ts", line: 3 });
    expect(file.added[0].title).not.toContain("<b>");
    expect((await post(`/tasks/${id}/findings`, { title: "x", severity: "huge" })).status).toBe(400);
  });
});
