// pack_runs: a `POST /runs` call's cost is the machine's spend like a stage run's, so the day's
// budget (spendSinceUsd) counts it.
import type { EngineId } from "@hardness/contracts";
import type { DataSource } from "typeorm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { freshTestDatabase } from "../../test/database.ts";
import { PgPackRunStore } from "./pack-run-store.ts";
import { StageRunEntity, TaskEntity } from "./schemas.ts";
import { PgTaskStore } from "./task-store.ts";
import { NO_RETRIES } from "../../domain/transition.ts";

let db: DataSource;
beforeAll(async () => {
  db = await freshTestDatabase();
});
afterAll(async () => {
  await db.destroy();
});
beforeEach(async () => {
  await db.query("truncate tasks, pack_runs, slack_triage_runs cascade");
});

const run = (startedAt: Date, costUsd: number | null) => ({
  pack: "chat_triage" as const, engine: "claude:haiku" as const, model: "m", client: "notch", ok: true, error: null, turns: 1, durationMs: 10, costUsd,
  startedAt: startedAt.toISOString(), endedAt: startedAt.toISOString(),
});

describe("spendSinceUsd", () => {
  it("counts the pack runs since then beside the stage runs", async () => {
    const task = await db.getRepository(TaskEntity).save({ title: "x", description: "", criteria: [], repoPath: null, branch: null, worktreePath: null, state: "triage", retries: { ...NO_RETRIES }, resumeTo: null, reason: null });
    await db.getRepository(StageRunEntity).save({ taskId: task.id, stage: "triage", attempt: 1, status: "passed", outcome: "pass", costUsd: "1.5000", startedAt: new Date() });
    const packs = new PgPackRunStore(db);
    await packs.record(run(new Date(), 0.25));
    await packs.record(run(new Date(), null));
    await packs.record(run(new Date(Date.now() - 3 * 86_400_000), 9));
    expect(await new PgTaskStore(db).spendSinceUsd(new Date(Date.now() - 86_400_000))).toBeCloseTo(1.75, 4);
  });
});

describe("engineSpendSinceUsd", () => {
  it("sums each engine's stage runs, pack runs and Slack triage runs since then; in a repo, that repo's stage runs only", async () => {
    const save = (repoPath: string | null) => db.getRepository(TaskEntity).save({ title: "x", description: "", criteria: [], repoPath, branch: null, worktreePath: null, state: "triage", retries: { ...NO_RETRIES }, resumeTo: null, reason: null });
    const inApp = await save("/r/app");
    const elsewhere = await save("/r/other");
    const stage = (taskId: string, engine: EngineId | null, costUsd: string | null, startedAt = new Date()) =>
      db.getRepository(StageRunEntity).save({ taskId, stage: "triage", attempt: 1, status: "passed", outcome: "pass", costUsd, engine, startedAt });
    await stage(inApp.id, "openai:sol", "2.0000");
    await stage(inApp.id, "openai:sol", "1.0000", new Date(Date.now() - 40 * 86_400_000));
    await stage(elsewhere.id, "openai:sol", "3.0000");
    await stage(elsewhere.id, null, "7.0000");
    await stage(elsewhere.id, "codex:sol", null);
    await new PgPackRunStore(db).record({ ...run(new Date(), 0.5), engine: "openai:sol" });
    await db.query("insert into slack_triage_runs (started_at, ended_at, engine, cost_usd) values (now(), now(), 'openai:luna', 0.25)");
    const since = new Date(Date.now() - 86_400_000);
    const store = new PgTaskStore(db);
    expect(Object.fromEntries(await store.engineSpendSinceUsd(since))).toEqual({ "openai:sol": 5.5, "openai:luna": 0.25, "codex:sol": 0 });
    expect(Object.fromEntries(await store.engineSpendSinceUsd(since, "/r/app"))).toEqual({ "openai:sol": 2 });
  });
});
