import type { DataSource } from "typeorm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Pipeline } from "../../application/pipeline.ts";
import { StubStages } from "../../application/stages/stubs.ts";
import { freshTestDatabase } from "../../test/database.ts";
import { createApp } from "./app.ts";
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

describe("GET /repos", () => {
  it("lists each repository's image and graph health", async () => {
    const health = [{ repo: "/a/shop", image: { inUse: "hardness-runner:dev", base: null, builtAt: null, lastFailure: null }, graph: { on: true, commit: "c", behind: 2, graphify: "0.9.34", builtAt: "t", building: false, lastFailure: null } }];
    const res = await createApp({ db, pipeline, bus: new Bus(), repoHealth: async () => health }).request("/repos");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(health);
  });

  it("is an empty list when the machine keeps no graphs or images", async () => {
    const res = await createApp({ db, pipeline, bus: new Bus() }).request("/repos");
    expect(await res.json()).toEqual([]);
  });
});
