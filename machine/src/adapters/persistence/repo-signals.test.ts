// The repo signals read a repo's stage runs, the loop guard's stops and the ledger's cost, per pack, from a date on.
import type { EngineId } from "@hardness/contracts";
import type { DataSource } from "typeorm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { EconomyStore } from "../../application/economy.ts";
import { NO_RETRIES } from "../../domain/transition.ts";
import { freshTestDatabase } from "../../test/database.ts";
import { pgRepoSignals } from "./repo-signals.ts";
import { EventEntity, StageRunEntity, TaskEntity } from "./schemas.ts";

let db: DataSource;
beforeAll(async () => {
  db = await freshTestDatabase();
});
afterAll(async () => {
  await db.destroy();
});
beforeEach(async () => {
  await db.query("truncate tasks cascade");
});

const DAY = 86_400_000;
const save = (repoPath: string) => db.getRepository(TaskEntity).save({ title: "x", description: "", criteria: [], repoPath, branch: null, worktreePath: null, state: "triage", retries: { ...NO_RETRIES }, resumeTo: null, reason: null });
const stage = (taskId: string, stageName: "verifying" | "setup", outcome: string, costUsd: string | null, ago = 0) =>
  db.getRepository(StageRunEntity).save({ taskId, stage: stageName, attempt: 1, status: outcome === "pass" ? "passed" : "failed", outcome, costUsd, startedAt: new Date(Date.now() - ago * DAY) });

// The machine's own record of a stage ending in escalation: the transition event. The stage run itself stays `fail`.
const escalate = (taskId: string, from: string, ago = 0, event = "stage_done") =>
  db.getRepository(EventEntity).save({ taskId, kind: "transition", stageRunId: null, payload: { event, outcome: "escalated", from, to: "escalated" }, at: new Date(Date.now() - ago * DAY) });

const economy = (guard: unknown[], ledger: unknown[]) => ({ guard: async () => guard, ledger: async () => ledger }) as unknown as EconomyStore;

describe("pgRepoSignals", () => {
  it("counts a pack's runs, escalations, stops and cost in the repo since the date", async () => {
    const mine = await save("/r/app");
    const other = await save("/r/other");
    await stage(mine.id, "verifying", "pass", "1.0000");
    // A loop-guard stop is stored as a failed stage run; the escalation is in the event log only.
    await stage(mine.id, "verifying", "fail", "2.0000");
    await escalate(mine.id, "verifying");
    await escalate(mine.id, "verifying", 40);
    await escalate(mine.id, "verifying", 0, "approved");
    await stage(mine.id, "setup", "pass", "0.5000");
    await stage(mine.id, "setup", "pass", "9.0000", 40);
    await stage(other.id, "setup", "fail", "7.0000");
    await escalate(other.id, "setup");
    const since = new Date(Date.now() - 30 * DAY);
    const at = new Date().toISOString();
    const old = new Date(Date.now() - 40 * DAY).toISOString();
    const signals = pgRepoSignals(
      db,
      economy(
        [
          { at, runId: "a", pack: "setup", action: "stop", calls: 9 },
          { at, runId: "b", pack: "setup", action: "gate", calls: 3 },
          { at: old, runId: "c", pack: "setup", action: "stop", calls: 9 },
        ],
        [
          { at, runId: "a", pack: "loop_judge", card: "c", kind: "overhead", effective: 0, tokens: null, costUsd: 0.25 },
          // A stage run's own ledger record: its cost is already in stage_runs.
          { at, runId: "t", pack: "verifying", card: "c", kind: "exec", effective: 0, tokens: null, costUsd: 5 },
        ],
      ),
    );
    const got = await signals.forRepo("/r/app", since);
    expect(got.verifying).toEqual({ runs: 2, escalations: 1, stuck: 0, costUsd: 3 });
    expect(got.setup).toEqual({ runs: 1, escalations: 0, stuck: 1, costUsd: 0.5 });
    expect(got.loop_judge).toEqual({ runs: 0, escalations: 0, stuck: 0, costUsd: 0.25 });
  });

  it("reports no signal for a state that several packs run in", async () => {
    const mine = await save("/r/app");
    for (let i = 0; i < 3; i++) await db.getRepository(StageRunEntity).save({ taskId: mine.id, stage: "test_design", attempt: 1, status: "failed", outcome: "fail", costUsd: "1.0000", startedAt: new Date() });
    await escalate(mine.id, "test_design");
    await stage(mine.id, "setup", "pass", "0.5000");
    const got = await pgRepoSignals(db, economy([], [])).forRepo("/r/app", new Date(Date.now() - DAY));
    expect(got.test_design).toBeUndefined();
    expect(got.plan).toBeUndefined();
    expect(got.setup).toEqual({ runs: 1, escalations: 0, stuck: 0, costUsd: 0.5 });
  });

  it("gives triage a signal although the question council runs inside it", async () => {
    const mine = await save("/r/app");
    for (let i = 0; i < 2; i++) await db.getRepository(StageRunEntity).save({ taskId: mine.id, stage: "triage", attempt: 1, status: "passed", outcome: "pass", costUsd: "0.2500", startedAt: new Date() });
    await escalate(mine.id, "triage");
    const got = await pgRepoSignals(db, economy([], [])).forRepo("/r/app", new Date(Date.now() - DAY));
    expect(got.triage).toEqual({ runs: 2, escalations: 1, stuck: 0, costUsd: 0.5 });
    expect(got.question_council).toBeUndefined();
  });

  it("counts a pack's runs per engine, and leaves out a run that recorded none", async () => {
    const mine = await save("/r/app");
    const run = (engine: EngineId | null) => db.getRepository(StageRunEntity).save({ taskId: mine.id, stage: "verifying", attempt: 1, status: "passed", outcome: "pass", costUsd: "1.0000", engine, startedAt: new Date() });
    await run("codex:sol");
    await run("codex:sol");
    await run("claude:opus");
    await run(null);
    const got = await pgRepoSignals(db, economy([], [])).forRepo("/r/app", new Date(Date.now() - DAY));
    expect(got.verifying).toEqual({ runs: 4, escalations: 0, stuck: 0, costUsd: 4, engines: { "codex:sol": 2, "claude:opus": 1 } });
  });

  it("is empty for a repo with no runs", async () => {
    expect(await pgRepoSignals(db, economy([], [])).forRepo("/r/none", new Date(0))).toEqual({});
  });
});
