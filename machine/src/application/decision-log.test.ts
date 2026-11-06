import { existsSync, mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DecisionRecord } from "@hardness/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import { DecisionLog, mergeTruth } from "./decision-log.ts";

let stateDir: string;
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "decision-log-"));
});

const record = (over: Partial<DecisionRecord> = {}): DecisionRecord => ({
  schema: 1,
  id: "r1",
  pack: "worth_learning",
  engine: "claude:haiku",
  model: "m",
  at: "2026-11-04T12:00:00.000Z",
  client: "ship",
  context: { ship: { kind: "retro" } },
  answer: { worth: { value: true, p: 0.9 } },
  verdicts: { worth: "proceed" },
  overall: "proceed",
  traceId: "t1",
  ...over,
});

describe("DecisionLog", () => {
  it("appends a record as a private regular file at decisions/<pack>/<day>/<id>.json, leaving no temp file", async () => {
    await new DecisionLog({ stateDir }).append(record());
    const dir = join(stateDir, "decisions", "worth_learning", "2026-11-04");
    expect(readdirSync(dir)).toEqual(["r1.json"]);
    const stat = statSync(join(dir, "r1.json"));
    expect(stat.isFile()).toBe(true);
    expect(stat.mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("writes nothing when switched off", async () => {
    await new DecisionLog({ stateDir, enabled: false }).append(record());
    expect(existsSync(join(stateDir, "decisions"))).toBe(false);
  });

  it("lists a pack's records oldest first, filtered by since and by having a truth", async () => {
    const log = new DecisionLog({ stateDir });
    await log.append(record({ id: "b", at: "2026-11-04T12:00:00.000Z" }));
    await log.append(record({ id: "a", at: "2026-11-02T08:00:00.000Z", truth: { label: { worth: { value: true } }, source: "retro", at: "2026-11-03T00:00:00.000Z" } }));
    await log.append(record({ id: "other", pack: "event_class", answer: {}, verdicts: {} }));
    expect((await log.list("worth_learning")).map((r) => r.id)).toEqual(["a", "b"]);
    expect((await log.list("worth_learning", { since: new Date("2026-11-03T00:00:00Z") })).map((r) => r.id)).toEqual(["b"]);
    expect((await log.list("worth_learning", { withTruth: true })).map((r) => r.id)).toEqual(["a"]);
    expect(await log.list("risk_score")).toEqual([]);
  });

  it("reads one record by id, and refuses an id that is not a file name", async () => {
    const log = new DecisionLog({ stateDir });
    await log.append(record());
    expect((await log.read("worth_learning", "r1"))?.traceId).toBe("t1");
    expect(await log.read("worth_learning", "nope")).toBeNull();
    expect(await log.read("worth_learning", "../../x")).toBeNull();
  });

  it("sets the truth by rewriting the one file, keeping its mode; false when there is no such record", async () => {
    const log = new DecisionLog({ stateDir });
    await log.append(record());
    const truth = { label: { worth: { value: false } }, source: "retro", at: "2026-11-05T00:00:00.000Z" };
    expect(await log.setTruth("worth_learning", "r1", truth)).toBe(true);
    expect((await log.read("worth_learning", "r1"))?.truth).toMatchObject(truth);
    expect(statSync(join(stateDir, "decisions", "worth_learning", "2026-11-04", "r1.json")).mode & 0o777).toBe(0o600);
    expect(await log.setTruth("worth_learning", "gone", truth)).toBe(false);
  });

  describe("a truth adds up", () => {
    const conversation = () => record({ pack: "conversation_assess", answer: { needs_reply: { value: false, p: 0.6 }, kind: { choice: "request", p: 0.7 } } });
    const at = (n: number) => `2026-11-05T09:0${n}:00.000Z`;

    it("keeps both labels when a kind override is followed by a sent draft (today the second erases the first)", async () => {
      const log = new DecisionLog({ stateDir });
      await log.append(conversation());
      await log.setTruth("conversation_assess", "r1", { label: { kind: { choice: "question" } }, source: "person", kind: "person", at: at(1) });
      await log.setTruth("conversation_assess", "r1", { label: { needs_reply: { value: true } }, source: "person", kind: "person", at: at(2) });
      const truth = (await log.read("conversation_assess", "r1"))!.truth!;
      expect(truth.label).toEqual({ kind: { choice: "question" }, needs_reply: { value: true } });
      expect(truth).toMatchObject({ source: "person", kind: "person", at: at(2) });
      expect(truth.history!.map((h) => h.label)).toEqual([{ kind: { choice: "question" } }, { needs_reply: { value: true } }]);
    });

    it("never lets an outcome overwrite a fact or a person's label, and lets a person overwrite either", async () => {
      const log = new DecisionLog({ stateDir });
      await log.append(conversation());
      await log.setTruth("conversation_assess", "r1", { label: { kind: { choice: "question" } }, source: "person", kind: "person", at: at(1) });
      await log.setTruth("conversation_assess", "r1", { label: { kind: { choice: "request" }, needs_reply: { value: true } }, source: "merged", kind: "outcome", at: at(2) });
      let truth = (await log.read("conversation_assess", "r1"))!.truth!;
      expect(truth.label).toEqual({ kind: { choice: "question" }, needs_reply: { value: true } });
      expect(truth).toMatchObject({ source: "merged", kind: "outcome" });
      await log.setTruth("conversation_assess", "r1", { label: { needs_reply: { value: false } }, source: "rerun", kind: "fact", at: at(3) });
      await log.setTruth("conversation_assess", "r1", { label: { needs_reply: { value: true } }, source: "later_outcome", kind: "outcome", at: at(4) });
      truth = (await log.read("conversation_assess", "r1"))!.truth!;
      expect(truth.label.needs_reply).toEqual({ value: false });
      expect(truth).toMatchObject({ source: "rerun", kind: "fact", at: at(3) });
      await log.setTruth("conversation_assess", "r1", { label: { needs_reply: { value: true } }, source: "person", kind: "person", at: at(5) });
      expect((await log.read("conversation_assess", "r1"))!.truth!.label.needs_reply).toEqual({ value: true });
    });

    it("lets the later of two equals win, reads a truth with no kind as a fact, and keeps at most 20 history entries", async () => {
      const log = new DecisionLog({ stateDir });
      await log.append(record({ truth: { label: { worth: { value: true } }, source: "old_fact", at: at(0) } }));
      await log.setTruth("worth_learning", "r1", { label: { worth: { value: false } }, source: "retro_closed", kind: "fact", at: at(1) });
      expect((await log.read("worth_learning", "r1"))!.truth).toMatchObject({ label: { worth: { value: false } }, source: "retro_closed" });
      await log.setTruth("worth_learning", "r1", { label: { worth: { value: true } }, source: "x", kind: "outcome", at: at(2) });
      expect((await log.read("worth_learning", "r1"))!.truth!.label.worth).toEqual({ value: false });
      for (let n = 0; n < 25; n++) await log.setTruth("worth_learning", "r1", { label: { worth: { value: n % 2 === 0 } }, source: `s${n}`, kind: "fact", at: `2026-11-06T09:${String(n).padStart(2, "0")}:00.000Z` });
      const truth = (await log.read("worth_learning", "r1"))!.truth!;
      expect(truth.history).toHaveLength(20);
      expect(truth.history!.at(-1)!.source).toBe("s24");
      expect(truth.history![0]!.source).toBe("s5");
    });
  });

  it("keeps a person's note with the label it came with, and an older note when a later truth brings none", () => {
    const first = mergeTruth(undefined, { label: { worth: { value: true } }, source: "person_cli", kind: "person", at: "a", note: "one-off" });
    expect(first.note).toBe("one-off");
    expect(mergeTruth(first, { label: { worth: { value: false } }, source: "person_cli", kind: "person", at: "b" }).note).toBe("one-off");
  });

  it("ranks a label pulled from the queue below a person's and a fact, above an outcome, and never over a person's", () => {
    const queue = { label: { worth: { value: false } }, source: "person_queue", kind: "queue" as const, at: "q" };
    const person = mergeTruth(undefined, { label: { worth: { value: true } }, source: "person_cli", kind: "person", at: "a" });
    expect(mergeTruth(person, queue)).toBe(person);
    const fact = mergeTruth(undefined, { label: { worth: { value: true } }, source: "slice_green", kind: "fact", at: "a" });
    expect(mergeTruth(fact, queue)).toBe(fact);
    const outcome = mergeTruth(undefined, { label: { worth: { value: true } }, source: "pr_merged", kind: "outcome", at: "a" });
    expect(mergeTruth(outcome, queue).label).toEqual({ worth: { value: false } });
    const held = mergeTruth(undefined, queue);
    expect(mergeTruth(held, { label: { worth: { value: true } }, source: "person_cli", kind: "person", at: "b" }).label).toEqual({ worth: { value: true } });
  });

  it("keeps each question's kind outside the 20-entry history, and a truth that changes nothing adds no entry", () => {
    let truth = mergeTruth(undefined, { label: { worth: { value: true } }, source: "person_cli", kind: "person", at: "p" });
    for (let i = 0; i < 30; i++) truth = mergeTruth(truth, { label: { other: { value: i % 2 === 0 } }, source: `fact${i}`, kind: "fact", at: `f${i}` });
    expect(truth.history).toHaveLength(20);
    expect(truth.history!.some((entry) => entry.kind === "person")).toBe(false);
    expect(truth.kinds).toMatchObject({ worth: "person", other: "fact" });
    // The person's label has fallen out of the history and still outranks a later fact.
    expect(mergeTruth(truth, { label: { worth: { value: false } }, source: "slice_green", kind: "fact", at: "z" })).toBe(truth);
    // The same label again changes nothing: the same object, no entry.
    expect(mergeTruth(truth, { label: { worth: { value: true } }, source: "person_cli", kind: "person", at: "again" })).toBe(truth);
    const count = truth.history!.length;
    expect(mergeTruth(truth, { label: { other: truth.label.other }, source: "again", kind: "fact", at: "again" }).history).toHaveLength(count);
  });
});
