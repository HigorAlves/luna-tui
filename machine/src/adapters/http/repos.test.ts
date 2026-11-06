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
    const health = [{ repo: "/a/shop", image: { inUse: "hardness-runner:dev", base: null, builtAt: null, lastFailure: null, pendingBase: null }, graph: { on: true, commit: "c", behind: 2, graphify: "0.9.34", builtAt: "t", building: false, lastFailure: null } }];
    const res = await createApp({ db, pipeline, bus: new Bus(), repoHealth: async () => health }).request("/repos");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(health);
  });

  it("is an empty list when the machine keeps no graphs or images", async () => {
    const res = await createApp({ db, pipeline, bus: new Bus() }).request("/repos");
    expect(await res.json()).toEqual([]);
  });

  it("approves the base the repository's luna.yaml names now, and refuses any other reference", async () => {
    const approved: Array<[string, string]> = [];
    const approveBase = async (repo: string, base: string) => (base === "debian:12" ? (approved.push([repo, base]), { ok: true as const }) : { ok: false as const, reason: "that is not the base in the repository's luna.yaml" });
    const app = createApp({ db, pipeline, bus: new Bus(), approveBase });
    const post = (body: unknown) => app.request("/repos/base/approve", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await post({ repo: "/a/shop", base: "debian:12" })).status).toBe(200);
    expect(approved).toEqual([["/a/shop", "debian:12"]]);
    const refused = await post({ repo: "/a/shop", base: "evil:1" });
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain("not the base");
    expect((await post({ repo: "/a/shop" })).status).toBe(400);
    expect(approved).toHaveLength(1);
  });
});
