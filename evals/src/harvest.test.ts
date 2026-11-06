import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DecisionRecord } from "@hardness/contracts";
import { buildContextPackInput } from "@hardness/machine/decisions";
import { describe, expect, it } from "vitest";

import { Expect } from "./expect.ts";
import { caseIdOf, harvest } from "./harvest.ts";

const retro = { kind: "retro", retro: { predicted: { size: "small", risk: "low", estLoc: 120 }, actual: { added: 640, removed: 90, retries: { verify: 2, e2e: 1, ci: 1, total: 5 }, escalations: 1, format: "captures", durationMin: 310 }, runs: 14 } };
const record = (over: Partial<DecisionRecord> = {}): DecisionRecord => ({
  schema: 1,
  id: "6b0f2c52-7a3e-4d0b-9c1e-0a1f2b3c4d5e",
  pack: "worth_learning",
  engine: "claude:haiku",
  model: "m",
  at: "2026-11-04T12:00:00.000Z",
  client: "ship",
  context: { ship: retro },
  answer: { worth: { value: true, p: 0.93 } },
  verdicts: { worth: "proceed" },
  overall: "proceed",
  traceId: "t-1",
  ...over,
});
const read = (dir: string, id: string, file: string) => JSON.parse(readFileSync(join(dir, "worth_learning", "cases", id, file), "utf8"));

describe("harvest of an event_class record stored before the nine classes", () => {
  it("writes the old label as its new one", () => {
    const dir = mkdtempSync(join(tmpdir(), "harvest-"));
    const ship = { kind: "event", event: { actor: "ana", isBot: false, isMe: false, kind: "comment", state: null, body: "rename tmp", url: null } };
    const out = harvest(dir, "event_class", [record({ pack: "event_class", context: { ship }, answer: { event: { choice: "comment", confidence: 0.9 } }, verdicts: { event: "proceed" }, truth: { label: { event: { choice: "comment" } }, source: "pr_merged", at: "2026-11-05T00:00:00.000Z" } })]);
    expect(out.written).toEqual(["rec-6b0f2c52"]);
    const written = JSON.parse(readFileSync(join(dir, "event_class", "cases", "rec-6b0f2c52", "expect.json"), "utf8"));
    expect(written.checks).toEqual([{ kind: "equals", path: "event.choice", value: "review_comment" }]);
    expect(written.label).toEqual({ event: { choice: "review_comment" } });
  });
});

describe("harvest", () => {
  it("writes a case from a record with a truth: the pack's input without an engine, equals checks, a rubric, and the way back to the record", () => {
    const dir = mkdtempSync(join(tmpdir(), "harvest-"));
    const out = harvest(dir, "worth_learning", [record({ truth: { label: { worth: { value: false } }, source: "retro_closed", at: "2026-11-05T00:00:00.000Z" } })]);
    expect(out).toEqual({ written: ["rec-6b0f2c52"], kept: [], refused: [] });
    expect(read(dir, "rec-6b0f2c52", "stage.json")).toEqual(JSON.parse(JSON.stringify(buildContextPackInput("worth_learning", { ship: retro } as never))));
    expect(read(dir, "rec-6b0f2c52", "stage.json")).not.toHaveProperty("engine");
    const expectation = Expect.parse(read(dir, "rec-6b0f2c52", "expect.json"));
    expect(expectation.checks).toEqual([{ kind: "equals", path: "worth.value", value: false }]);
    expect(expectation).toMatchObject({ label: { worth: { value: false } }, recordId: "6b0f2c52-7a3e-4d0b-9c1e-0a1f2b3c4d5e", traceId: "t-1" });
    expect(expectation.rubric).toMatch(/^worth: Would a retro/);
    expect(expectation.review).toBeUndefined();
  });

  it("marks a record without a truth for review, with no checks, and keeps the model's answer to prefill a queue", () => {
    const dir = mkdtempSync(join(tmpdir(), "harvest-"));
    harvest(dir, "worth_learning", [record()]);
    expect(Expect.parse(read(dir, "rec-6b0f2c52", "expect.json"))).toMatchObject({ review: true, checks: [], modelAnswer: { worth: { value: true, p: 0.93 } } });
  });

  it("writes a case from an outcome truth with its label, marked for review so a person confirms it before it counts", () => {
    const dir = mkdtempSync(join(tmpdir(), "harvest-"));
    harvest(dir, "worth_learning", [record({ truth: { label: { worth: { value: true } }, source: "pr_merged", kind: "outcome", at: "2026-11-05T00:00:00.000Z" } })]);
    expect(Expect.parse(read(dir, "rec-6b0f2c52", "expect.json"))).toMatchObject({ label: { worth: { value: true } }, review: true });
  });

  it("does not mark a person's or a fact's label for review", () => {
    const dir = mkdtempSync(join(tmpdir(), "harvest-"));
    harvest(dir, "worth_learning", [record({ truth: { label: { worth: { value: true } }, source: "retro_approved", kind: "person", at: "2026-11-05T00:00:00.000Z" } })]);
    expect(Expect.parse(read(dir, "rec-6b0f2c52", "expect.json"))).not.toHaveProperty("review");
  });

  it("refuses a record marked private, whatever its context holds", () => {
    const dir = mkdtempSync(join(tmpdir(), "harvest-"));
    const out = harvest(dir, "worth_learning", [record({ private: true })]);
    expect(out.written).toEqual([]);
    expect(out.refused).toEqual([{ id: "6b0f2c52-7a3e-4d0b-9c1e-0a1f2b3c4d5e", reason: "a private conversation: its text never becomes a case" }]);
  });

  it("keeps a case that exists, whatever the record now says", () => {
    const dir = mkdtempSync(join(tmpdir(), "harvest-"));
    harvest(dir, "worth_learning", [record()]);
    const again = harvest(dir, "worth_learning", [record({ truth: { label: { worth: { value: true } }, source: "x", at: "2026-11-05T00:00:00.000Z" } })]);
    expect(again).toEqual({ written: [], kept: ["rec-6b0f2c52"], refused: [] });
    expect(read(dir, "rec-6b0f2c52", "expect.json").review).toBe(true);
  });

  it("names a refused record and writes nothing for it: a token-shaped string, or a context off the pack's schema", () => {
    const dir = mkdtempSync(join(tmpdir(), "harvest-"));
    const token = ["gh", "p_", "b".repeat(36)].join("");
    const dirty = record({ id: "aaaa1111-0000-0000-0000-000000000000", context: { ship: { ...retro, note: token } } });
    const odd = record({ id: "bbbb2222-0000-0000-0000-000000000000", context: { ship: { kind: "nope" } } });
    const out = harvest(dir, "worth_learning", [dirty, odd]);
    expect(out.written).toEqual([]);
    expect(out.refused.map((r) => r.id)).toEqual(["aaaa1111-0000-0000-0000-000000000000", "bbbb2222-0000-0000-0000-000000000000"]);
    expect(out.refused[0]!.reason).toMatch(/token-shaped string at ship\.note/);
    expect(out.refused[1]!.reason).toMatch(/off the pack's schema/);
    expect(existsSync(join(dir, "worth_learning"))).toBe(false);
  });

  it("turns any name into a safe case id", () => {
    expect(caseIdOf("../../etc/passwd")).toBe("..-etc-passwd".replace(/^[.-]+/, ""));
    expect(caseIdOf("task 7/x")).toBe("task-7-x");
    expect(caseIdOf("...")).toBeNull();
  });

  it("skips a decision record of a private conversation: nothing of it becomes a case, and the report says why", () => {
    const dir = mkdtempSync(join(tmpdir(), "harvest-"));
    const conversation = { channel: "secret", private: true, thread: ["marta: the plan is banana"], latest: "the plan is banana", author: { profile: "member", title: null }, candidates: [] };
    const out = harvest(dir, "conversation_assess", [record({ pack: "conversation_assess", context: { conversation }, truth: { label: { kind: { choice: "question" } }, source: "person", at: "2026-11-05T00:00:00.000Z" } } as never)]);
    expect(out.written).toEqual([]);
    expect(out.refused).toEqual([{ id: "6b0f2c52-7a3e-4d0b-9c1e-0a1f2b3c4d5e", reason: "a private conversation: its text never becomes a case" }]);
  });
});

describe("a harvested case's kind", () => {
  it("is labelled, with no reading: its label is a recorded truth", () => {
    const dir = mkdtempSync(join(tmpdir(), "harvest-"));
    harvest(dir, "worth_learning", [record({ truth: { label: { worth: { value: true } }, source: "person", kind: "person", at: "2026-11-05T00:00:00.000Z" } })]);
    const written = read(dir, "rec-6b0f2c52", "expect.json");
    expect(written.kind).toBe("labelled");
    expect(written.reading).toBeUndefined();
    harvest(dir, "worth_learning", [record({ id: "7c1f2c52-7a3e-4d0b-9c1e-0a1f2b3c4d5e" })]);
    expect(read(dir, "rec-7c1f2c52", "expect.json").kind).toBeUndefined();
  });
});
