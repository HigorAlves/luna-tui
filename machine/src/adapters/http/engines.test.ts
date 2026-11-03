import { ENGINES, type EngineId } from "@hardness/contracts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DataSource } from "typeorm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Pipeline } from "../../application/pipeline.ts";
import { StubStages } from "../../application/stages/stubs.ts";
import { freshTestDatabase } from "../../test/database.ts";
import { EngineBudgetWatch, gatedCredentials, runtimeKillSwitch } from "../../application/engine-gates.ts";
import { PgPackRunStore } from "../persistence/pack-run-store.ts";
import { PgTaskStore } from "../persistence/task-store.ts";
import { fixedCredentials, machineCredentials } from "../credentials/index.ts";
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
    expect(engines.find((e) => e.id === "claude:opus")).toEqual({ id: "claude:opus", runtime: "claude", modelId: "claude-opus-5-5", auth: "subscription", status: "ga", available: true, spentThisMonthUsd: 0, budgetUsd: null });
    expect(engines.find((e) => e.id === "codex:sol")).toEqual({ id: "codex:sol", runtime: "eve", modelId: "gpt-5.6-terra", auth: "chatgpt", status: "preview", available: false, reason: "no credential for codex:sol", spentThisMonthUsd: 0, budgetUsd: null });
    expect(engines.find((e) => e.id === "openai:luna")).toMatchObject({ runtime: "eve", auth: "api-key", available: false });
    expect(engines.find((e) => e.id === "jev")).toMatchObject({ runtime: "jev", modelId: "jev-latest", auth: "api-key", available: false });
  });

  it("says an engine on a runtime MACHINE_DISABLE_RUNTIMES turned off is not available, and why", async () => {
    const pipeline = new Pipeline(db, new StubStages().runnerFor, { inline: true, hasConfig: () => true });
    const credentials = gatedCredentials(fixedCredentials({}), [runtimeKillSwitch(["eve"])]);
    const engines = (await (await createApp({ db, pipeline, bus: new Bus(), credentials }).request("/engines")).json()) as Array<Record<string, unknown>>;
    expect(engines.find((e) => e.id === "codex:sol")).toMatchObject({ available: false, reason: "disabled by MACHINE_DISABLE_RUNTIMES" });
    expect(engines.find((e) => e.id === "jev")).toMatchObject({ available: true });
    expect(engines.find((e) => e.id === "claude:opus")).toMatchObject({ available: true });
  });

  it("says each engine's spend this calendar month and the machine's cap on it", async () => {
    await db.query("truncate pack_runs");
    const pipeline = new Pipeline(db, new StubStages().runnerFor, { inline: true, hasConfig: () => true });
    await new PgPackRunStore(db).record({ pack: "issue_classify", engine: "jev", model: "m", client: null, ok: true, error: null, turns: 1, durationMs: 1, costUsd: 1.25, startedAt: new Date().toISOString(), endedAt: new Date().toISOString() });
    const engineBudgets = new EngineBudgetWatch({ budgets: { typesafe: 5 }, spend: new PgTaskStore(db), onAlert: () => {} });
    const engines = (await (await createApp({ db, pipeline, bus: new Bus(), credentials: fixedCredentials({}), engineBudgets }).request("/engines")).json()) as Array<Record<string, unknown>>;
    expect(engines.find((e) => e.id === "jev")).toMatchObject({ available: true, spentThisMonthUsd: 1.25, budgetUsd: 5 });
    expect(engines.find((e) => e.id === "openai:sol")).toMatchObject({ spentThisMonthUsd: 0, budgetUsd: null });
  });

  it("shows jev available with either Jev key, the Vercel AI Gateway's or TypeSafe's, and never the key", async () => {
    const pipeline = new Pipeline(db, new StubStages().runnerFor, { inline: true, hasConfig: () => true });
    const home = mkdtempSync(join(tmpdir(), "engines-home-"));
    for (const env of [{ AI_GATEWAY_API_KEY: "gw-secret" }, { TYPESAFE_API_KEY: "ts-secret" }]) {
      const response = await createApp({ db, pipeline, bus: new Bus(), credentials: machineCredentials({ env, home }) }).request("/engines");
      const text = await response.text();
      expect((JSON.parse(text) as Array<Record<string, unknown>>).find((e) => e.id === "jev")).toMatchObject({ available: true });
      expect(text).not.toMatch(/secret/);
    }
  });
});
