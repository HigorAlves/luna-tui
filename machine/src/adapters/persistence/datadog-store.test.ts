import type { DatadogItem } from "@hardness/contracts";
import type { DataSource } from "typeorm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { type DatadogStore, InMemoryDatadogStore } from "../../application/datadog-store.ts";
import { freshTestDatabase } from "../../test/database.ts";
import { PgDatadogStore } from "./datadog-store.ts";

const now = new Date("2026-10-28T12:00:00Z");
const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000).toISOString();

const item = (id: string, over: Partial<DatadogItem> = {}): DatadogItem => ({
  id,
  source: "monitor",
  title: "checkout latency",
  service: "checkout",
  env: "prod",
  status: "Alert",
  severity: "P2",
  count: null,
  firstSeen: daysAgo(2),
  lastSeen: daysAgo(1),
  url: "https://app.datadoghq.com/monitors/1",
  samples: ["p95 > 2s"],
  repository: null,
  floor: null,
  triage: null,
  split: "investigate",
  snoozedUntil: null,
  doneAt: null,
  reopenedAt: null,
  taskId: null,
  ...over,
});

const run = { endedAt: daysAgo(0), items: 3, model: "claude-haiku", turns: 1, costUsd: 0.0123, ok: true, error: null };
const cutoff = (days: number) => new Date(now.getTime() - days * 86_400_000);

let db: DataSource;
beforeAll(async () => {
  db = await freshTestDatabase();
});
afterAll(async () => {
  await db.destroy();
});

const stores: [string, () => Promise<DatadogStore>][] = [
  ["PgDatadogStore", async () => {
    await db.query("truncate datadog_items, datadog_triage_runs");
    return new PgDatadogStore(db);
  }],
  ["InMemoryDatadogStore", async () => new InMemoryDatadogStore()],
];

describe.each(stores)("%s", (_name, make) => {
  let store: DatadogStore;
  beforeEach(async () => {
    store = await make();
  });

  it("saves, replaces and reads an item back unchanged, with its triage", async () => {
    const triage: NonNullable<DatadogItem["triage"]> = { priority: "P1", category: "degradation", summary: "s", why: "w", suspectedCause: null, nextStep: "look", refs: [{ kind: "url", ref: "https://x" }], by: "model", triagedAt: now.toISOString(), overridden: false };
    await store.save([item("mon:1:a"), item("inc:2", { source: "incident", doneAt: daysAgo(2) })]);
    await store.save([item("mon:1:a", { title: "edited", triage })]);
    expect((await store.items(new Date(0))).map((i) => i.id).sort()).toEqual(["inc:2", "mon:1:a"]);
    expect(await store.item("mon:1:a")).toEqual(item("mon:1:a", { title: "edited", triage }));
    expect(await store.item("inc:2")).toMatchObject({ doneAt: daysAgo(2) });
    expect(await store.item("nope")).toBeNull();
  });

  it("keeps open items and done ones after the cutoff only", async () => {
    await store.save([item("a"), item("b", { doneAt: daysAgo(10) }), item("c", { doneAt: daysAgo(40) })]);
    expect((await store.items(cutoff(30))).map((i) => i.id).sort()).toEqual(["a", "b"]);
    expect(await store.items(now)).toEqual([expect.objectContaining({ id: "a" })]);
  });

  it("prunes items done before a cutoff and runs started before another, leaving open items alone", async () => {
    await store.save([item("open"), item("fresh", { doneAt: daysAgo(10) }), item("stale", { doneAt: daysAgo(40) })]);
    await store.recordTriageRun({ ...run, startedAt: daysAgo(100) });
    await store.recordTriageRun({ ...run, startedAt: daysAgo(1) });
    expect(await store.prune(cutoff(30), cutoff(90))).toEqual({ items: 1, runs: 1 });
    expect((await store.items(new Date(0))).map((i) => i.id).sort()).toEqual(["fresh", "open"]);
    expect((await store.triageRuns(new Date(0))).map((r) => r.startedAt)).toEqual([daysAgo(1)]);
    expect(await store.prune(cutoff(30), null)).toEqual({ items: 0, runs: 0 });
  });

  it("starts empty", async () => {
    expect(await store.items(now)).toEqual([]);
    expect(await store.triageRuns(new Date(0))).toEqual([]);
  });

  it("records a run with its cost and lists the ones in a window, newest first", async () => {
    const saved = await store.recordTriageRun({ ...run, startedAt: daysAgo(1) });
    await store.recordTriageRun({ ...run, startedAt: daysAgo(10), ok: false, costUsd: null, error: "timed out" });
    await store.recordTriageRun({ ...run, startedAt: daysAgo(0) });
    expect(saved).toMatchObject({ id: expect.any(String), startedAt: daysAgo(1), items: 3, costUsd: 0.0123, ok: true, error: null });
    const week = await store.triageRuns(cutoff(7));
    expect(week.map((r) => r.startedAt)).toEqual([daysAgo(0), daysAgo(1)]);
    expect(week[0]!.costUsd).toBe(0.0123);
    const all = await store.triageRuns(new Date(0));
    expect(all).toHaveLength(3);
    expect(all[2]).toMatchObject({ ok: false, costUsd: null, error: "timed out" });
  });
});
