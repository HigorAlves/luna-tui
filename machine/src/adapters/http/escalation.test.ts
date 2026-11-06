// `POST /tasks/:id/escalation-reason`: a person corrects the reason Build's escalation was decided with. The enum only; only at an escalated gate; the card stays where it is.
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
  pipeline = new Pipeline(db, (stage) => (stage === "implementing" ? async () => ({ outcome: "escalated" as const, detail: { escalation: "other", reason: "stuck" } }) : stubs.runnerFor(stage)), { inline: true, policies: previewOn, hasConfig: () => true });
});

const post = async (id: string, body: unknown) => {
  const response = await createApp({ db, pipeline, bus: new Bus() }).request(`/tasks/${id}/escalation-reason`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
};
const escalated = async () => {
  const task = await pipeline.createTask({ title: "Login" });
  await pipeline.start(task.id);
  await pipeline.decide(task.id, "approved");
  return task.id;
};

describe("POST /tasks/:id/escalation-reason", () => {
  it("takes one of the six reasons and leaves the card escalated", async () => {
    const id = await escalated();
    const out = await post(id, { reason: "env_broken" });
    expect(out.status).toBe(200);
    expect(out.body.state).toBe("escalated");
    expect((await pipeline.events(id)).some((e) => e.kind === "escalation.corrected" && e.payload.to === "env_broken")).toBe(true);
  });

  it("refuses anything but the enum (400) and a card that is not escalated (409)", async () => {
    const id = await escalated();
    expect((await post(id, { reason: "head_moved" })).status).toBe(400);
    expect((await post(id, { reason: "free text" })).status).toBe(400);
    expect((await post(id, {})).status).toBe(400);
    const other = await pipeline.createTask({ title: "Other" });
    expect(await post(other.id, { reason: "env_broken" })).toMatchObject({ status: 409, body: { error: "no_escalation" } });
  });
});
