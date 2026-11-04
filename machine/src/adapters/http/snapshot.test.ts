// A task snapshot (`GET /tasks`, `GET /tasks/:id`, `task.updated` and the replay) says what the
// last stage said and what the gate asks, so a client back from sleep needs no GET per task.
import type { Task } from "@hardness/contracts";
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

const app = () => createApp({ db, pipeline, bus: new Bus() });
const one = async (id: string) => ((await (await app().request(`/tasks/${id}`)).json()) as { task: Task }).task;
const all = async () => (await (await app().request("/tasks")).json()) as Task[];

describe("a task snapshot's lastRun and gate", () => {
  it("are null for a task nothing ran on", async () => {
    const task = await pipeline.createTask({ title: "Login" });
    expect(await one(task.id)).toMatchObject({ lastRun: null, gate: null });
    expect((await all())[0]).toMatchObject({ lastRun: null, gate: null });
  });

  it("carry the stage's summary and the plan the gate asks you to approve, in one task and in the list", async () => {
    stubs.plan("triage", { outcome: "pass", detail: { summary: "Adds an error to the login form", brief: "b", confidence: "high" } });
    const task = await pipeline.createTask({ title: "Login" });
    await pipeline.start(task.id);
    const snapshot = await one(task.id);
    expect(snapshot.lastRun).toEqual({ stage: "triage", engine: null, outcome: "pass", summary: "Adds an error to the login form", at: expect.any(String) });
    expect(snapshot.gate).toEqual({ state: "awaiting_approval", requested: expect.objectContaining({ summary: "Adds an error to the login form", brief: "b" }) });
    expect((await all())[0]).toMatchObject({ lastRun: snapshot.lastRun, gate: snapshot.gate });
  });

  it("cut a long summary to 2000 characters, and drop the gate once it is answered", async () => {
    stubs.plan("triage", { outcome: "pass", detail: { summary: "x".repeat(5000) } });
    const task = await pipeline.createTask({ title: "Login" });
    await pipeline.start(task.id);
    expect((await one(task.id)).lastRun?.summary).toHaveLength(2000);
    await pipeline.decide(task.id, "approved");
    const after = await one(task.id);
    expect(after.state).toBe("awaiting_test_check");
    expect(after.lastRun?.stage).toBe("test_design");
    expect(after.gate?.state).toBe("awaiting_test_check");
  });

  it("show a failed stage's error when it said nothing else", async () => {
    stubs.plan("triage", { outcome: "fail", detail: { error: "no repo" } });
    const task = await pipeline.createTask({ title: "Login" });
    await pipeline.start(task.id);
    expect(await one(task.id)).toMatchObject({ state: "escalated", lastRun: { stage: "triage", outcome: "fail", summary: "no repo" }, gate: { state: "escalated" } });
  });

  it("ride on the replayed task.updated too", async () => {
    stubs.plan("triage", { outcome: "pass", detail: { summary: "s" } });
    const task = await pipeline.createTask({ title: "Login" });
    await pipeline.start(task.id);
    const response = await app().request("/events?since=0");
    const reader = response.body!.getReader();
    let text = "";
    while (!text.includes("event: ready")) text += new TextDecoder().decode((await reader.read()).value);
    await reader.cancel();
    const updated = JSON.parse(/event: task.updated\ndata: (.*)/.exec(text)![1]!) as { task: Task };
    expect(updated.task).toMatchObject({ lastRun: { stage: "triage", summary: "s" }, gate: { state: "awaiting_approval" } });
  });
});

describe("a task snapshot's classification", () => {
  it("is what intake stored from triage_signals, in one task and in the list; null on a task intake did not classify", async () => {
    const classification = { kind: "bug", area: "board", ready: true, size: 1, confidence: 0.85, at: "2026-11-03T12:00:00.000Z", model: "typesafe-ai/jev" };
    const classified = await pipeline.createTask({ title: "Board crashes", classification });
    const plain = await pipeline.createTask({ title: "Login" });
    expect((await one(classified.id)).classification).toEqual(classification);
    expect((await one(plain.id)).classification).toBeNull();
    expect((await all()).map((t) => t.classification)).toEqual([classification, null]);
  });
});
