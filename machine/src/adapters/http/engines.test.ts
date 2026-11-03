import { ENGINES, type EngineId } from "@hardness/contracts";
import type { DataSource } from "typeorm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Pipeline } from "../../application/pipeline.ts";
import { StubStages } from "../../application/stages/stubs.ts";
import { freshTestDatabase } from "../../test/database.ts";
import { createApp } from "./app.ts";
import { Bus } from "./bus.ts";

let db: DataSource;

beforeAll(async () => {
  db = await freshTestDatabase();
});
afterAll(async () => {
  await db.destroy();
});

describe("GET /engines", () => {
  it("lists every engine with its runtime, pinned model, how it is paid, its catalog status and whether this machine has its credential", async () => {
    const pipeline = new Pipeline(db, new StubStages().runnerFor, { inline: true, hasConfig: () => true });
    const credentials = {
      check: async (engine: EngineId) => (engine.startsWith("claude:") ? { available: true as const } : { available: false as const, reason: `no credential for ${engine}` }),
      prepare: () => Promise.reject(new Error("not here")),
    };
    const response = await createApp({ db, pipeline, bus: new Bus(), credentials }).request("/engines");
    expect(response.status).toBe(200);
    const engines = (await response.json()) as Array<Record<string, unknown>>;
    expect(engines.map((e) => e.id)).toEqual(Object.keys(ENGINES));
    expect(engines.find((e) => e.id === "claude:opus")).toEqual({ id: "claude:opus", runtime: "claude", modelId: "claude-opus-5-5", auth: "subscription", status: "ga", available: true });
    expect(engines.find((e) => e.id === "codex:sol")).toEqual({ id: "codex:sol", runtime: "eve", modelId: "gpt-5.6-terra", auth: "chatgpt", status: "preview", available: false, reason: "no credential for codex:sol" });
    expect(engines.find((e) => e.id === "openai:luna")).toMatchObject({ runtime: "eve", auth: "api-key", available: false });
    expect(engines.find((e) => e.id === "jev")).toMatchObject({ runtime: "jev", modelId: "jev-latest", auth: "api-key", available: false });
  });
});
