import type { Metrics } from "@hardness/contracts";
import type { DataSource } from "typeorm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { Pipeline } from "../../application/pipeline.ts";
import type { StageResult } from "../../application/ports.ts";
import { StubStages } from "../../application/stages/stubs.ts";
import { freshTestDatabase } from "../../test/database.ts";
import { createApp } from "./app.ts";
import { Bus } from "./bus.ts";
import { percentile } from "./metrics.ts";

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
  pipeline = new Pipeline(db, stubs.runnerFor, { inline: true, maxConcurrentTasks: 2 });
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
  for (let i = 0; i < 4; i++) await pipeline.decide(closed.id, "approved");

  stubs.plan("verifying", fail, fail, fail);
  const escalated = await pipeline.createTask({ title: "escalated" });
  await pipeline.start(escalated.id);
  await pipeline.decide(escalated.id, "approved");
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
    expect(m.queue).toEqual({ depth: 0, slots: { max: 2, active: 0, draining: false }, utilisation: 0 });
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

    pipeline = new Pipeline(db, stubs.runnerFor, { inline: true, maxConcurrentTasks: 2, budget: { taskUsd: 5, dailyUsd: 10 } });
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

  it("rejects a bad since with the error shape", async () => {
    const response = await app().request("/metrics?since=bogus");
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_request" });
  });
});
