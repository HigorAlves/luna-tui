// A task's own engine per stage: set on the work order (`POST /tasks` `stages`), changed with
// `PATCH /tasks/:id/stages` until that stage starts, and shown on the task.
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

const call = async (method: string, path: string, body: unknown) => {
  const response = await createApp({ db, pipeline, bus: new Bus() }).request(path, { method, body: JSON.stringify(body), headers: { "content-type": "application/json" } });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};

// Each pack allows only its default today, so an allowed choice is the default spelled out.
describe("stages on the work order", () => {
  it("keeps the engines a task names, and shows them on the task", async () => {
    const made = await call("POST", "/tasks", { title: "Login page", stages: { triage: "claude:opus", verifying: "claude:opus" } });
    expect(made).toMatchObject({ status: 201, body: { stages: { triage: "claude:opus", verifying: "claude:opus" } } });
    expect((await pipeline.get(String(made.body.id))).stages).toEqual({ triage: "claude:opus", verifying: "claude:opus" });
    expect((await call("POST", "/tasks", { title: "Plain" })).body.stages).toEqual({});
  });

  it("is 400 for an engine the pack does not allow, or a pack that never runs in a task, and makes no task", async () => {
    expect(await call("POST", "/tasks", { title: "x", stages: { implementing: "codex:sol" } })).toMatchObject({ status: 400, body: { error: "invalid_request", message: expect.stringMatching(/stages\.implementing: codex:sol is not allowed for implementing/) } });
    expect(await call("POST", "/tasks", { title: "x", stages: { slack_triage: "claude:haiku" } })).toMatchObject({ status: 400, body: { message: expect.stringMatching(/stages\.slack_triage: .*not in a task/) } });
    expect(await call("POST", "/tasks", { title: "x", stages: { triage: "gpt-6" } })).toMatchObject({ status: 400 });
    expect(await pipeline.list()).toHaveLength(0);
  });
});

describe("PATCH /tasks/:id/stages", () => {
  it("sets a pack's engine, keeps the others, and clears one with null", async () => {
    const task = await pipeline.createTask({ title: "Login page" });
    expect(await call("PATCH", `/tasks/${task.id}/stages`, { stages: { triage: "claude:opus" } })).toMatchObject({ status: 200, body: { stages: { triage: "claude:opus" } } });
    expect((await call("PATCH", `/tasks/${task.id}/stages`, { stages: { implementing: "claude:sonnet" } })).body.stages).toEqual({ triage: "claude:opus", implementing: "claude:sonnet" });
    expect((await call("PATCH", `/tasks/${task.id}/stages`, { stages: { triage: null } })).body.stages).toEqual({ implementing: "claude:sonnet" });
    expect((await pipeline.events(task.id)).filter((e) => e.kind === "task.stages").map((e) => e.payload)).toEqual([
      { stages: { triage: "claude:opus" } },
      { stages: { implementing: "claude:sonnet" } },
      { stages: { triage: null } },
    ]);
  });

  it("is 400 for an engine the pack does not allow, and changes nothing", async () => {
    const task = await pipeline.createTask({ title: "Login page" });
    expect(await call("PATCH", `/tasks/${task.id}/stages`, { stages: { implementing: "codex:sol" } })).toMatchObject({ status: 400, body: { error: "invalid_request" } });
    expect((await pipeline.get(task.id)).stages).toEqual({});
  });

  it("is 409 stage_started for a pack whose stage has run on the task, and changes none of the packs named", async () => {
    const task = await pipeline.createTask({ title: "Login page" });
    await pipeline.start(task.id);
    expect((await pipeline.get(task.id)).state).toBe("awaiting_approval");
    const refused = await call("PATCH", `/tasks/${task.id}/stages`, { stages: { implementing: "claude:sonnet", triage: "claude:opus" } });
    expect(refused).toMatchObject({ status: 409, body: { error: "stage_started", message: expect.stringMatching(/triage/) } });
    expect((await pipeline.get(task.id)).stages).toEqual({});
    // A stage still ahead of the task can change.
    expect((await call("PATCH", `/tasks/${task.id}/stages`, { stages: { implementing: "claude:sonnet" } })).status).toBe(200);
  });

  it("is 404 for a task that does not exist", async () => {
    expect((await call("PATCH", "/tasks/00000000-0000-0000-0000-000000000000/stages", { stages: {} })).status).toBe(404);
  });
});
