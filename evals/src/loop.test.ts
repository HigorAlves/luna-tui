import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DecisionRecord } from "@hardness/contracts";
import type { Datapoint, QueueItem } from "@hardness/machine/telemetry";
import { describe, expect, it } from "vitest";

import { loadCases } from "./cases.ts";
import { runHarvest, runPull, runPush } from "./loop.ts";

const retro = { kind: "retro", retro: { predicted: { size: "small", risk: "low", estLoc: 120 }, actual: { added: 640, removed: 90, retries: { verify: 2, e2e: 1, ci: 1, total: 5 }, escalations: 1, format: "captures", durationMin: 310 }, runs: 14 } };
const record = (id: string, truth?: DecisionRecord["truth"]): DecisionRecord => ({
  schema: 1, id, pack: "worth_learning", engine: "claude:haiku", model: "m", at: "2026-11-04T12:00:00.000Z", client: "ship", context: { ship: retro },
  answer: { worth: { value: true, p: 0.9 } }, verdicts: { worth: "proceed" }, overall: "proceed", traceId: null, stage: "ship", ...(truth ? { truth } : {}),
});

function fakeTelemetry(pulled: Datapoint[] = []) {
  const sent = { datasets: [] as Array<[string, Datapoint[]]>, queue: [] as Array<[string, QueueItem[]]> };
  return {
    sent,
    datasets: { push: async (name: string, points: Datapoint[]) => (sent.datasets.push([name, points]), { pushed: points.length }), pull: async () => pulled },
    queue: { push: async (name: string, items: QueueItem[]) => (sent.queue.push([name, items]), { pushed: items.length }) },
  };
}

describe("the loop", () => {
  it("harvests what the log lists, passing the filters on", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loop-"));
    const asked: unknown[] = [];
    const out = await runHarvest(dir, "worth_learning", { list: async (pack, options) => (asked.push([pack, options]), [record("11111111-aaaa", { label: { worth: { value: true } }, source: "x", at: "2026-11-05T00:00:00.000Z" }), record("22222222-bbbb")]) }, { withTruth: false, since: new Date("2026-11-01") });
    expect(out.written).toEqual(["rec-11111111", "rec-22222222"]);
    expect(asked).toEqual([["worth_learning", { withTruth: false, since: new Date("2026-11-01") }]]);
  });

  it("harvests only the pipeline's own records unless asked for all of them", async () => {
    const own = { ...record("11111111-aaaa"), stage: "ship" };
    const client = { ...record("22222222-bbbb"), stage: undefined };
    const dir = mkdtempSync(join(tmpdir(), "loop-"));
    expect((await runHarvest(dir, "worth_learning", { list: async () => [own, client] }, {})).written).toEqual(["rec-11111111"]);
    const all = mkdtempSync(join(tmpdir(), "loop-"));
    expect((await runHarvest(all, "worth_learning", { list: async () => [own, client] }, { all: true })).written).toEqual(["rec-11111111", "rec-22222222"]);
  });

  it("harvests a record the machine made itself even when it names no stage (intake, tickets, conversations, triage), and still skips an old one a client made", async () => {
    const machine = { ...record("11111111-aaaa"), stage: undefined, client: "intake", origin: "machine" as const };
    const oldClient = { ...record("22222222-bbbb"), stage: undefined, client: "intake" };
    const newClient = { ...record("33333333-cccc"), stage: "ship", origin: "client" as const };
    const dir = mkdtempSync(join(tmpdir(), "loop-"));
    expect((await runHarvest(dir, "worth_learning", { list: async () => [machine, oldClient, newClient] }, {})).written).toEqual(["rec-11111111"]);
  });

  it("pushes every case to the dataset named for the pack, and nothing to a queue without --queue", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loop-"));
    await runHarvest(dir, "worth_learning", { list: async () => [record("11111111-aaaa"), record("22222222-bbbb", { label: { worth: { value: false } }, source: "x", at: "t" })] }, {});
    const t = fakeTelemetry();
    const out = await runPush(dir, "worth_learning", t);
    expect(out).toEqual({ dataset: { name: "worth_learning", pushed: 2 } });
    expect(t.sent.datasets[0]![0]).toBe("worth_learning");
    expect(t.sent.queue).toEqual([]);
  });

  it("with --queue sends the cases awaiting a label, and with records the unlabelled records that are not cases yet, the model's answer as the target", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loop-"));
    await runHarvest(dir, "worth_learning", { list: async () => [record("11111111-aaaa")] }, {});
    const t = fakeTelemetry();
    const out = await runPush(dir, "worth_learning", t, { queue: "review worth_learning", records: [record("11111111-aaaa"), record("33333333-cccc"), record("44444444-dddd", { label: { worth: { value: true } }, source: "x", at: "t" })] });
    expect(out.queue).toEqual({ name: "review worth_learning", pushed: 2 });
    expect(t.sent.queue[0]![1].map((i) => i.idempotencyKey)).toEqual(["11111111-aaaa", "33333333-cccc"]);
    expect(t.sent.queue[0]![1][1]!.target).toEqual({ worth: { value: true } });
  });

  it("pulls labelled datapoints into cases, keeps one that exists and reports a bad one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loop-"));
    const t = fakeTelemetry([
      { taskId: "reviewed-1", data: { ship: retro }, target: { worth: { value: false } } },
      { taskId: "broken", data: { ship: 1 }, target: { worth: { value: false } } },
    ]);
    expect(await runPull(dir, "worth_learning", t)).toMatchObject({ written: ["reviewed-1"], kept: [], skipped: [{ taskId: "broken" }] });
    expect(await runPull(dir, "worth_learning", t)).toMatchObject({ written: [], kept: ["reviewed-1"] });
    expect(loadCases(dir, "worth_learning").map((c) => c.id)).toEqual(["reviewed-1"]);
  });
});
