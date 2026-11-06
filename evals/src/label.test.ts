import type { DecisionRecord, DecisionTruth } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import { labelFor, nextToLabel, renderNext, setLabel } from "./label.ts";

const record = (over: Partial<DecisionRecord> = {}): DecisionRecord => ({
  schema: 1, id: "11111111-aaaa", pack: "worth_learning", engine: "claude:haiku", model: "m", at: "2026-11-04T12:00:00.000Z", client: "ship",
  context: { ship: { kind: "retro", text: "a\u001b[31m red" } }, answer: { worth: { value: true, p: 0.9 } }, verdicts: { worth: "proceed" }, overall: "proceed", traceId: null, origin: "machine", ...over,
});

describe("labelFor", () => {
  it("builds a label from question=value pairs by the question's type", () => {
    expect(labelFor("worth_learning", ["worth=false"])).toEqual({ ok: true, label: { worth: { value: false } } });
    expect(labelFor("event_class", ["event=ci_real"])).toMatchObject({ ok: true, label: { event: { choice: "ci_real" } } });
    expect(labelFor("risk_score", ["blast_radius=1"])).toMatchObject({ ok: true });
  });
  it("refuses a value that is not a label of the question, naming what is allowed", () => {
    const bad = labelFor("worth_learning", ["worth=maybe"]);
    expect(bad).toMatchObject({ ok: false });
    expect((bad as { reason: string }).reason).toContain("true, false");
    const choice = labelFor("event_class", ["event=lunch"]);
    expect((choice as { reason: string }).reason).toContain("ci_real");
    expect(labelFor("worth_learning", ["nope=true"])).toMatchObject({ ok: false });
    expect(labelFor("worth_learning", ["worth"])).toMatchObject({ ok: false });
    expect(labelFor("worth_learning", [])).toMatchObject({ ok: false });
    expect(labelFor("risk_score", ["blast_radius=99"])).toMatchObject({ ok: false });
  });
});

describe("setLabel", () => {
  it("writes a person truth with the source person_cli and the note, on the record", async () => {
    const written: DecisionTruth[] = [];
    const log = { read: async () => record(), setTruth: async (_p: string, _i: string, t: DecisionTruth) => (written.push(t), true) };
    const out = await setLabel(log, "worth_learning", "11111111-aaaa", ["worth=false"], "it was a one-off", new Date("2026-11-06T00:00:00Z"));
    expect(out).toEqual({ ok: true });
    expect(written[0]).toMatchObject({ label: { worth: { value: false } }, source: "person_cli", kind: "person", at: "2026-11-06T00:00:00.000Z", note: "it was a one-off" });
  });
  it("says so when the record does not exist, and writes nothing for a bad value", async () => {
    let calls = 0;
    const log = { read: async () => null, setTruth: async () => (calls++, true) };
    expect(await setLabel(log, "worth_learning", "x", ["worth=false"], undefined)).toMatchObject({ ok: false });
    expect(await setLabel({ ...log, read: async () => record() }, "worth_learning", "x", ["worth=zzz"], undefined)).toMatchObject({ ok: false });
    expect(calls).toBe(0);
  });
});

describe("next", () => {
  it("is the oldest record with no person truth, skipping one a person labelled", () => {
    const person = record({ id: "1", at: "2026-11-01T00:00:00Z", truth: { label: { worth: { value: true } }, source: "x", at: "a", kind: "person" } });
    const fact = record({ id: "2", at: "2026-11-02T00:00:00Z", truth: { label: { worth: { value: true } }, source: "x", at: "a", kind: "fact" } });
    const plain = record({ id: "3", at: "2026-11-03T00:00:00Z" });
    expect(nextToLabel([plain, fact, person])?.id).toBe("2");
    expect(nextToLabel([person])).toBeNull();
  });
  it("prints the context flattened and capped, with control characters gone, the answer, the allowed labels and the command", () => {
    const text = renderNext(record({ context: { ship: { text: `x\u001b[31m${"y".repeat(9000)}` } } })).join("\n");
    expect(text).not.toContain("\u001b");
    expect(text.length).toBeLessThan(6000);
    expect(text).toContain("worth");
    expect(text).toContain("true, false");
    expect(text).toContain("pnpm eval label --pack worth_learning --record 11111111-aaaa --set worth=");
  });
  it("never prints a private record's text", () => {
    const text = renderNext(record({ private: true, context: { conversation: { latest: "secret talk" } } })).join("\n");
    expect(text).not.toContain("secret talk");
    expect(text).toContain("private");
  });
});
