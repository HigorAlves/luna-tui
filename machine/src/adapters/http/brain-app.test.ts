import type { DataSource } from "typeorm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { noBrain } from "../../application/brain.ts";
import type { Admission } from "../../application/brain-admission.ts";
import { noClaims } from "../../application/brain-claims.ts";
import { Pipeline } from "../../application/pipeline.ts";
import { StubStages } from "../../application/stages/stubs.ts";
import { freshTestDatabase } from "../../test/database.ts";
import { createApp } from "./app.ts";
import { trackProjector } from "./brain.ts";
import { Bus } from "./bus.ts";

let db: DataSource;
let pipeline: Pipeline;
beforeAll(async () => {
  db = await freshTestDatabase();
  pipeline = new Pipeline(db, new StubStages().runnerFor, { inline: true, hasConfig: () => true, maxConcurrentTasks: 2 });
});
afterAll(async () => {
  await db.destroy();
});

describe("the app with no brain wired", () => {
  it("answers /brain/health with enabled false, and the commands with the off result", async () => {
    const app = createApp({ db, pipeline, bus: new Bus() });
    const health = await app.request("/brain/health");
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ enabled: false, ok: false, last: null });
    const project = await app.request("/brain/project", { method: "POST" });
    expect(project.status).toBe(200);
    expect(await project.json()).toMatchObject({ note: "the brain is off" });
  });
});

describe("the claim routes through createApp", () => {
  const projector = () => trackProjector({ run: async () => ({ tasks: 0, loaded: 0, skipped: 0, unlinked: 0, hygiene: [], note: null }), rebuild: async () => ({ tasks: 0, loaded: 0, skipped: 0, unlinked: 0, hygiene: [], note: null }) });
  const admission: Admission = { propose: async () => [], remember: async () => { throw new Error("unused"); }, settle: async () => ({ problem: "not_found" }) };

  it("answers GET /brain/claims with 200 when claims and admission are given", async () => {
    const app = createApp({ db, pipeline, bus: new Bus(), brain: { brain: noBrain(), projector: projector(), claims: noClaims(), admission } });
    const res = await app.request("/brain/claims");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ claims: [], stats: { waiting: 0, decided: 0, agreed: 0, missed: 0, ready: false } });
  });

  it("answers 503 brain_claims_off without them, with either one missing too", async () => {
    for (const brain of [undefined, { brain: noBrain(), projector: projector() }, { brain: noBrain(), projector: projector(), claims: noClaims() }, { brain: noBrain(), projector: projector(), admission }]) {
      const app = createApp({ db, pipeline, bus: new Bus(), ...(brain ? { brain } : {}) });
      const res = await app.request("/brain/claims");
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ error: "brain_claims_off" });
    }
  });
});
