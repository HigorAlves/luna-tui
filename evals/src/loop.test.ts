import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DecisionRecord } from "@hardness/contracts";
import type { Datapoint, QueueItem } from "@hardness/machine/telemetry";
import { describe, expect, it } from "vitest";

import { loadCases } from "./cases.ts";
import { runHarvest, runLabelPush, runPull, runPush } from "./loop.ts";

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

const QUEUE = "b3ea1137-0000-4000-8000-000000000001";
describe("label push", () => {
  const asRecord = (id: string, over: Partial<DecisionRecord> = {}) => ({ ...record(id), origin: "machine" as const, ...over });
  const source = (records: DecisionRecord[]) => ({ list: async () => records });

  it("refuses a queue named by anything but its id, with the sentence that says why", async () => {
    await expect(runLabelPush(source([]), fakeTelemetry(), { queue: "luna-decisions", packs: ["worth_learning"], hintOf: () => undefined })).rejects.toThrow(/id.*cannot list queues|cannot list queues.*id/s);
  });

  it("sends only queue-state records of the machine, scrubbed, the answer as the target, the record id as the key, and names the local-only ones without sending them", async () => {
    const t = fakeTelemetry();
    const secretShaped = { ship: { ...retro, note: `x ${"gh"}p_${"c".repeat(30)}` } };
    const out = await runLabelPush(
      source([asRecord("aaaa1111"), asRecord("bbbb2222", { private: true }), asRecord("cccc3333", { context: secretShaped }), asRecord("dddd4444", { truth: { label: { worth: { value: true } }, source: "x", at: "t", kind: "person" } }), asRecord("eeee5555", { origin: "client" })]),
      t,
      { queue: QUEUE, packs: ["worth_learning"], hintOf: (id) => (id === "aaaa1111" ? { machineLevel: "P2", personLevel: "P0" } : undefined) },
    );
    expect(out.pushed).toBe(1);
    expect(out.localOnly.map((r) => r.id).sort()).toEqual(["bbbb2222", "cccc3333"]);
    expect(t.sent.queue[0]![0]).toBe(QUEUE);
    const [item] = t.sent.queue[0]![1];
    expect(item).toMatchObject({ idempotencyKey: "aaaa1111", target: { worth: { value: true } }, metadata: { pack: "worth_learning", source: "record", recordId: "aaaa1111", hint: { machineLevel: "P2", personLevel: "P0" } } });
    expect(JSON.stringify(t.sent.queue)).not.toContain("c".repeat(30));
  });

  it("sends nothing when nothing waits", async () => {
    const t = fakeTelemetry();
    const out = await runLabelPush(source([]), t, { queue: QUEUE, packs: ["worth_learning"], hintOf: () => undefined });
    expect(out).toMatchObject({ pushed: 0, localOnly: [] });
    expect(t.sent.queue).toEqual([]);
  });
});

describe("pull and what it writes back", () => {
  const waiting = (id: string, over: Partial<DecisionRecord> = {}): DecisionRecord => ({ ...record(id), origin: "machine", ...over });
  const mem = (records: DecisionRecord[]) => {
    const set: Array<[string, string, unknown]> = [];
    return { set, source: { read: async (_p: unknown, id: string) => records.find((r) => r.id === id) ?? null, setTruth: async (pack: string, id: string, truth: unknown) => (set.push([pack, id, truth]), true) } };
  };
  const points = (): Datapoint[] => [
    { taskId: "reviewed-9", data: { ship: retro }, target: { worth: { value: false } }, metadata: { recordId: "11111111-aaaa" } },
    { taskId: "reviewed-8", data: { ship: retro }, target: { worth: { value: true } }, metadata: { recordId: "gone" } },
  ];

  it("writes nothing back without the flag, and says which records a label could go to", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loop-"));
    const { set, source } = mem([waiting("11111111-aaaa")]);
    const out = await runPull(dir, "worth_learning", fakeTelemetry(points()), { records: source });
    expect(set).toEqual([]);
    expect(out.pending).toEqual(["11111111-aaaa"]);
    expect(out.labelled).toEqual([]);
  });

  it("with the flag prints each label first, then writes a queue truth on a record that waits for a label; a record that is not here keeps the case without its id", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loop-"));
    const { set, source } = mem([waiting("11111111-aaaa")]);
    const lines: string[] = [];
    const out = await runPull(dir, "worth_learning", fakeTelemetry(points()), { records: source, writeLabels: true, print: (line) => lines.push(line) });
    expect(out.written.sort()).toEqual(["reviewed-8", "reviewed-9"]);
    expect(lines).toEqual(["label worth_learning/11111111-aaaa: worth=false"]);
    expect(set).toHaveLength(1);
    expect(set[0]![2]).toMatchObject({ label: { worth: { value: false } }, source: "person_queue", kind: "queue" });
    expect(out.labelled).toEqual(["11111111-aaaa"]);
    const cases = loadCases(dir, "worth_learning");
    expect(cases.find((c) => c.id === "reviewed-8")!.expect.recordId).toBeUndefined();
  });

  it("refuses a record that has a person's label, is private, or is a client's: no label is written", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loop-"));
    const labelled = waiting("11111111-aaaa", { truth: { label: { worth: { value: true } }, source: "person_cli", kind: "person", at: "t" } });
    const { set, source } = mem([labelled]);
    const out = await runPull(dir, "worth_learning", fakeTelemetry([points()[0]!]), { records: source, writeLabels: true });
    expect(set).toEqual([]);
    expect(out.labelled).toEqual([]);
    const priv = mem([waiting("11111111-aaaa", { private: true })]);
    await runPull(mkdtempSync(join(tmpdir(), "loop-")), "worth_learning", fakeTelemetry([points()[0]!]), { records: priv.source, writeLabels: true });
    expect(priv.set).toEqual([]);
  });

  it("writes nothing back when no record source is given", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loop-"));
    const out = await runPull(dir, "worth_learning", fakeTelemetry(points()), { writeLabels: true });
    expect(out.labelled).toEqual([]);
    expect(out.pending).toEqual([]);
  });

  it("skips a datapoint whose label is not valid for the pack: an unknown question, a label the question does not have, a wrong type, extra keys", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loop-"));
    const bad: Datapoint[] = [
      { taskId: "bad-1", data: { ship: retro }, target: { nothing: { value: true } } },
      { taskId: "bad-2", data: { ship: retro }, target: { worth: { choice: "maybe" } } },
      { taskId: "bad-3", data: { ship: retro }, target: { worth: { value: "yes" } } },
      { taskId: "bad-4", data: { ship: retro }, target: { worth: { value: true, extra: "text" } } },
      { taskId: "good-1", data: { ship: retro }, target: { worth: { value: true } } },
    ];
    const out = await runPull(dir, "worth_learning", fakeTelemetry(bad), {});
    expect(out.written).toEqual(["good-1"]);
    expect(out.skipped.map((s) => s.taskId)).toEqual(["bad-1", "bad-2", "bad-3", "bad-4"]);
    expect(out.skipped[0]!.reason).toMatch(/not valid for worth_learning/);
  });
});

describe("dataset push --queue", () => {
  it("sends only records in the queue state: not a private one, not one with a truth, not one the scrub refuses, not a client's", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loop-"));
    const t = fakeTelemetry();
    const own = (id: string, over: Partial<DecisionRecord> = {}): DecisionRecord => ({ ...record(id), origin: "machine", ...over });
    const token = `x ${"gh"}p_${"d".repeat(30)}`;
    await runPush(dir, "worth_learning", t, { queue: "q", records: [own("aaaa1111"), own("bbbb2222", { private: true }), own("cccc3333", { truth: { label: {}, source: "x", at: "t" } }), own("dddd4444", { context: { ship: { ...retro, note: token } } }), own("eeee5555", { origin: "client" }), own("ffff6666", { context: {} })] });
    expect(t.sent.queue[0]![1].map((i) => i.idempotencyKey)).toEqual(["aaaa1111"]);
  });
});
