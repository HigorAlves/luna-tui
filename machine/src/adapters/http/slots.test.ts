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
  pipeline = new Pipeline(db, stubs.runnerFor, { inline: true, maxConcurrentTasks: 2 });
});

const app = () => createApp({ db, pipeline, bus: new Bus() });
const call = async (path: string, init?: RequestInit) => {
  const response = await app().request(path, init);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};

describe("drain, resume and slots over HTTP", () => {
  it("drains and resumes, and says so on /health", async () => {
    expect((await call("/health")).body).toMatchObject({ ok: true, slots: { max: 2, active: 0, draining: false } });
    expect((await call("/drain", { method: "POST" })).body).toMatchObject({ max: 2, draining: true });
    expect((await call("/health")).body).toMatchObject({ slots: { draining: true } });
    expect((await call("/resume", { method: "POST" })).body).toMatchObject({ draining: false });
  });

  it("resizes the pool with PATCH /slots and rejects a pool of none", async () => {
    const ok = await call("/slots", { method: "PATCH", body: JSON.stringify({ max: 3 }), headers: { "content-type": "application/json" } });
    expect(ok).toMatchObject({ status: 200, body: { max: 3 } });
    const bad = await call("/slots", { method: "PATCH", body: JSON.stringify({ max: 0 }), headers: { "content-type": "application/json" } });
    expect(bad.status).toBe(400);
  });
});
