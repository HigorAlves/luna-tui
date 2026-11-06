import type { EngineId, Metrics, TaskState } from "@hardness/contracts";
import type { DataSource } from "typeorm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { previewOn } from "../../test/policies.ts";

import { Pipeline } from "../../application/pipeline.ts";
import type { StageResult } from "../../application/ports.ts";
import { StubStages } from "../../application/stages/stubs.ts";
import { freshTestDatabase } from "../../test/database.ts";
import { createApp } from "./app.ts";
import { Bus } from "./bus.ts";
import { percentile } from "./metrics.ts";
import { EventEntity, StageRunEntity } from "../persistence/schemas.ts";
import type { StageRunRow } from "../../domain/task.ts";

let db: DataSource;
const stubs = new StubStages();
let pipeline: Pipeline;

const fail: StageResult = { outcome: "fail" };

beforeAll(async () => {
  db = await freshTestDatabase();
});

afterAll(async () => {
  await db.destroy();
});

beforeEach(async () => {
  await db.query("truncate tasks cascade");
  stubs.reset();
  pipeline = new Pipeline(db, stubs.runnerFor, { inline: true, policies: previewOn, hasConfig: () => true, maxConcurrentTasks: 2 });
});

const app = () => createApp({ db, pipeline, bus: new Bus() });

async function getMetrics(query = ""): Promise<Metrics> {
  const response = await app().request(`/metrics${query}`);
  expect(response.status).toBe(200);
  return (await response.json()) as Metrics;
}

/** A closed task, an escalated one (verify fails 3 times), and one still in backlog. */
async function seed() {
  const closed = await pipeline.createTask({ title: "closed" });
  await pipeline.start(closed.id);
  for (let i = 0; i < 3; i++) await pipeline.decide(closed.id, "approved");

  stubs.plan("verifying", fail, fail, fail);
  const escalated = await pipeline.createTask({ title: "escalated" });
  await pipeline.start(escalated.id);
  await pipeline.decide(escalated.id, "approved");

  const backlog = await pipeline.createTask({ title: "backlog" });
  return { closed, escalated, backlog };
}

describe("percentile", () => {
  it("interpolates like percentile_cont", () => {
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(percentile([10, 20, 30, 40, 50], 0.9)).toBe(46);
    expect(percentile([7], 0.9)).toBe(7);
  });

  it("is null without data, never NaN", () => {
    expect(percentile([], 0.5)).toBeNull();
  });
});

describe("GET /metrics", () => {
  it("is all zeros and nulls on an empty database", async () => {
    const m = await getMetrics();
    expect(m.tasks).toEqual({ created: 0, closed: 0, open: 0, waitingOnYou: 0, running: 0, queued: 0 });
    expect(m.cycleTimeMs.task).toEqual({ median: null, p90: null });
    expect(m.firstPassRate).toEqual({ verifying: null, ci_watch: null, implementing: null });
    expect(m.escalations).toEqual({ rate: null, topReasons: [] });
    expect(m.cost.totalUsd).toBe(0);
    expect(m.gates).toEqual({ withinSla: null, answered: 0, waitMs: {} });
    expect(m.queue).toEqual({ depth: 0, slots: { max: 2, active: 0, draining: false, latched: [] }, utilisation: 0 });
  });

  it("carries the flow numbers from the named events: null on an empty database, a plan cycle and a build run for a task that went through", async () => {
    expect((await getMetrics()).flow).toMatchObject({ planCycleMs: { median: null, n: 0 }, buildRuns: { value: null, n: 0 }, mergesPerWeek: { n: 0 }, changeFailureRate: { value: null }, timeToRestoreMs: { value: null } });
    const task = await pipeline.createTask({ title: "flows" });
    await pipeline.start(task.id);
    for (let i = 0; i < 3; i++) await pipeline.decide(task.id, "approved");
    const { flow } = await getMetrics();
    expect(flow?.planCycleMs.n).toBe(1);
    expect(flow?.planCycleMs.median).toBeGreaterThanOrEqual(0);
    expect(flow?.buildRuns).toEqual({ value: 1, n: 1 });
  });

  it("counts the gates answered in the window, the share inside the gate SLA and the median wait per gate", async () => {
    const { closed, escalated } = await seed();
    const m = await getMetrics();
    // The closed task passed three gates (plan, ship, memory); the escalated one answered one and still waits at escalated.
    expect(m.gates.answered).toBe(4);
    expect(m.gates.withinSla).toBe(1);
    expect(Object.keys(m.gates.waitMs).sort()).toEqual(["awaiting_approval", "awaiting_ship", "reviewing_memory"]);
    expect(m.gates.waitMs.awaiting_approval!.median).toBeGreaterThanOrEqual(0);
    // An answer older than the SLA counts against it: push the closed task's plan approval back in time.
    await db.query("update events set at = at - interval '3 hours' where task_id = $1 and payload->>'to' = 'awaiting_approval'", [closed.id]);
    const late = await getMetrics();
    expect(late.gates.answered).toBe(4);
    expect(late.gates.withinSla).toBeCloseTo(3 / 4);
    expect(late.gates.waitMs.awaiting_approval!.p90).toBeGreaterThan(2.5 * 3600 * 1000);
    expect(escalated.id).toBeTruthy();
  });

  it("counts tasks, cycle time, first pass, escalations and retries from a seeded pipeline", async () => {
    const { closed } = await seed();
    const m = await getMetrics();

    expect(new Date(m.until).getTime()).toBeGreaterThan(new Date(m.since).getTime());
    expect(m.tasks).toMatchObject({ created: 3, closed: 1, open: 2, waitingOnYou: 1, running: 0, queued: 0 });
    expect(m.cycleTimeMs.task.median).toBeGreaterThan(0);
    // Four verifying runs: one for the closed task, three failures for the escalated one.
    expect(m.cycleTimeMs.perStage.verifying?.runs).toBe(4);
    expect(m.cycleTimeMs.perStage.verifying?.median).toBeGreaterThanOrEqual(0);
    expect(m.firstPassRate.verifying).toBe(0.5);
    expect(m.firstPassRate.implementing).toBe(1);
    expect(m.firstPassRate.ci_watch).toBe(1);
    expect(m.escalations.rate).toBe(0.5);
    expect(m.escalations.topReasons).toContainEqual({ reason: "verify failed 3 times", count: 1 });
    expect(m.retries.byLoop).toEqual({ verify: 3, e2e: 0, ci: 0 });
    expect(m.retries.perTask.median).toBe(2);
    expect(m.cost.totalUsd).toBe(0);
    expect(m.cost.perTaskUsd).toEqual({ median: null, p90: null });
    expect(m.queue.depth).toBe(0);
    expect(closed.id).toBeTruthy();
  });

  it("sums cost from stage runs, per stage and per task", async () => {
    const { closed } = await seed();
    await db.query(
      "update stage_runs set cost_usd = 1.5 where id = (select id from stage_runs where task_id = $1 and stage = 'implementing' limit 1)",
      [closed.id],
    );
    const m = await getMetrics("?since=30d");
    expect(m.cost.totalUsd).toBe(1.5);
    expect(m.cost.byStage.implementing).toBe(1.5);
    expect(m.cost.perTaskUsd).toEqual({ median: 1.5, p90: 1.5 });
  });

  it("reports the spend ceilings and what is left of the day's", async () => {
    expect((await getMetrics()).budget).toEqual({ taskUsd: null, dailyUsd: null, spentTodayUsd: 0, remainingTodayUsd: null });

    pipeline = new Pipeline(db, stubs.runnerFor, { inline: true, policies: previewOn, hasConfig: () => true, maxConcurrentTasks: 2, budget: { taskUsd: 5, dailyUsd: 10 } });
    const { closed } = await seed();
    await db.query("update stage_runs set cost_usd = 1.5 where task_id = $1 and stage = 'implementing'", [closed.id]);
    await db.query("update stage_runs set cost_usd = 4, started_at = now() - interval '2 days' where task_id = $1 and stage = 'triage'", [closed.id]);
    expect((await getMetrics()).budget).toEqual({ taskUsd: 5, dailyUsd: 10, spentTodayUsd: 1.5, remainingTodayUsd: 8.5 });
  });

  it("filters by window", async () => {
    await seed();
    const future = new Date(Date.now() + 60_000).toISOString();
    const m = await getMetrics(`?since=${encodeURIComponent(future)}`);
    expect(m.tasks).toMatchObject({ created: 0, closed: 0, open: 2 });
    expect(m.escalations.rate).toBeNull();
  });

  it("accepts 7d, 30d and an ISO timestamp for since", async () => {
    const week = await getMetrics("?since=7d");
    const month = await getMetrics("?since=30d");
    const iso = await getMetrics("?since=2026-01-01T00:00:00Z");
    const span = (m: Metrics) => new Date(m.until).getTime() - new Date(m.since).getTime();
    expect(span(week)).toBeCloseTo(7 * 86_400_000, -3);
    expect(span(month)).toBeCloseTo(30 * 86_400_000, -3);
    expect(iso.since).toBe("2026-01-01T00:00:00.000Z");
  });

  it("filters by repo, and groups by repo with one slim row per checkout", async () => {
    const a = await pipeline.createTask({ title: "a", repoPath: "/r/a" });
    await pipeline.start(a.id);
    for (let i = 0; i < 3; i++) await pipeline.decide(a.id, "approved");
    stubs.plan("verifying", fail, fail, fail);
    const b = await pipeline.createTask({ title: "b", repoPath: "/r/b" });
    await pipeline.start(b.id);
    await pipeline.decide(b.id, "approved");
    await pipeline.createTask({ title: "none" });

    const onlyA = await getMetrics("?repo=/r/a");
    expect(onlyA.repo).toBe("/r/a");
    expect(onlyA.tasks).toMatchObject({ created: 1, closed: 1, open: 0 });
    expect(onlyA.escalations.rate).toBe(0);
    expect(onlyA.cycleTimeMs.perStage.verifying?.runs).toBe(1);
    const onlyB = await getMetrics("?repo=/r/b");
    expect(onlyB.tasks).toMatchObject({ created: 1, closed: 0, open: 1, waitingOnYou: 1 });
    expect(onlyB.escalations.rate).toBe(1);
    expect(onlyB.retries.byLoop.verify).toBe(3);

    const grouped = await getMetrics("?groupBy=repo");
    expect(grouped.tasks.created).toBe(3);
    expect(grouped.byRepo).toEqual([
      {
        repo: "/r/a",
        tasks: { created: 1, closed: 1, open: 0, waitingOnYou: 0, running: 0, queued: 0 },
        escalationRate: 0,
        firstPassVerifying: 1,
        costUsd: 0,
      },
      {
        repo: "/r/b",
        tasks: { created: 1, closed: 0, open: 1, waitingOnYou: 1, running: 0, queued: 0 },
        escalationRate: 1,
        firstPassVerifying: 0,
        costUsd: 0,
      },
      {
        repo: null,
        tasks: { created: 1, closed: 0, open: 1, waitingOnYou: 0, running: 0, queued: 0 },
        escalationRate: null,
        firstPassVerifying: null,
        costUsd: 0,
      },
    ]);
    expect((await getMetrics()).byRepo).toBeUndefined();
    const refused = await app().request("/metrics?groupBy=stage");
    expect(refused.status).toBe(400);
    expect(JSON.stringify(await refused.json())).toMatch(/repo, engine, fingerprint/);
  });

  it("groups the window's stage runs by fingerprint, runs from before fingerprints last", async () => {
    const task = await pipeline.createTask({ title: "a", repoPath: "/r/a" });
    const now = Date.now();
    const at = (msAgo: number) => new Date(now - msAgo);
    const runs = db.getRepository(StageRunEntity);
    const A = "a".repeat(64);
    const B = "b".repeat(64);
    const row = (stage: string, status: string, fingerprint: string | null, engine: string, costUsd: string | null, ms: number) =>
      runs.save({ taskId: task.id, stage: stage as never, attempt: 1, status: status as never, outcome: null, costUsd, fingerprint, engine: engine as never, startedAt: at(ms + 1000), endedAt: at(1000) });
    await row("triage", "passed", A, "claude:opus", "0.5000", 2000);
    await row("verifying", "failed", A, "claude:sonnet", "0.2500", 4000);
    await row("triage", "passed", B, "codex:sol", null, 1000);
    await row("triage", "passed", null, "claude:opus", "1.0000", 3000);

    const m = await getMetrics("?groupBy=fingerprint");
    expect(m.byFingerprint).toEqual([
      { fingerprint: A, runs: 2, passRate: 0.5, costUsd: 0.75, durationMs: { median: 3000, p90: 3800 }, stages: ["triage", "verifying"], engines: ["claude:opus", "claude:sonnet"] },
      { fingerprint: B, runs: 1, passRate: 1, costUsd: 0, durationMs: { median: 1000, p90: 1000 }, stages: ["triage"], engines: ["codex:sol"] },
      { fingerprint: null, runs: 1, passRate: 1, costUsd: 1, durationMs: { median: 3000, p90: 3000 }, stages: ["triage"], engines: ["claude:opus"] },
    ]);
    expect(m.byRepo).toBeUndefined();
    expect((await getMetrics("?groupBy=fingerprint&repo=/r/b")).byFingerprint).toEqual([]);
    expect((await getMetrics()).byFingerprint).toBeUndefined();
  });

  it("groups the window's stage runs by the engine they ran on, with groupBy=engine", async () => {
    const a = await pipeline.createTask({ title: "a", repoPath: "/r/x" });
    const b = await pipeline.createTask({ title: "b", repoPath: "/r/x" });
    const c = await pipeline.createTask({ title: "c", repoPath: "/r/x" });
    const now = Date.now();
    const at = (secondsAgo: number) => new Date(now - secondsAgo * 1000);
    const run = (taskId: string, stage: string, attempt: number, engine: EngineId | null, status: StageRunRow["status"], outcome: string, turns: number | null, costUsd: string | null, startedAgo: number, seconds: number) =>
      db.getRepository(StageRunEntity).save({ taskId, stage: stage as TaskState, attempt, engine, status, outcome, turns, costUsd, startedAt: at(startedAgo), endedAt: at(startedAgo - seconds) });
    // a: Codex hit its limit, Claude answered. b: Codex passed triage, Claude failed verifying and the task escalated.
    await run(a.id, "triage", 1, "codex:sol", "paused", "rate_limited", 1, null, 900, 10);
    await run(a.id, "triage", 2, "claude:opus", "passed", "pass", 10, "1.5", 880, 120);
    await run(b.id, "triage", 1, "codex:sol", "passed", "pass", 6, null, 800, 60);
    await run(b.id, "verifying", 1, "claude:opus", "failed", "fail", 20, "2.5", 600, 300);
    await db.getRepository(EventEntity).save({ taskId: b.id, kind: "transition", payload: { from: "verifying", to: "escalated" }, at: at(200) });
    await run(c.id, "triage", 1, null, "passed", "pass", null, null, 500, 30);

    const grouped = await getMetrics("?groupBy=engine");
    expect(grouped.byRepo).toBeUndefined();
    expect(grouped.byEngine).toEqual([
      { engine: "claude:opus", stageRuns: 2, firstPassRate: 0, escalations: 1, rateLimited: 0, meanTurns: 15, meanDurationMs: 210_000, costUsd: 4 },
      { engine: "codex:sol", stageRuns: 2, firstPassRate: 1, escalations: 0, rateLimited: 1, meanTurns: 6, meanDurationMs: 60_000, costUsd: 0 },
      { engine: null, stageRuns: 1, firstPassRate: 1, escalations: 0, rateLimited: 0, meanTurns: null, meanDurationMs: 30_000, costUsd: 0 },
    ]);
    expect((await getMetrics("?groupBy=engine&repo=/r/other")).byEngine).toEqual([]);
    expect((await getMetrics()).byEngine).toBeUndefined();
  });

  it("rejects a bad since with the error shape", async () => {
    const response = await app().request("/metrics?since=bogus");
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_request" });
  });
});
