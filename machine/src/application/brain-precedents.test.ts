import { describe, expect, it } from "vitest";

import { brainPrecedents } from "./brain-precedents.ts";
import type { Brain } from "./brain.ts";

type Row = Record<string, string | null>;
const row = (over: Row = {}): Row => ({ verdict: "verdict:r1", question: "kind", answer: "bug", truth: "feature", truth_source: "person", decided_at: "2026-10-03T08:15:00.000Z", card: "card:old1", title: "Export CSV", ...over });

function fakeBrain(rows: Row[], options: { enabled?: boolean; fails?: boolean } = {}): Brain & { asked: Array<{ name: string; params: unknown }> } {
  const asked: Array<{ name: string; params: unknown }> = [];
  return {
    asked,
    enabled: options.enabled ?? true,
    health: async () => ({ ok: true, version: null, note: null }),
    load: async () => ({ entities: 0, commit: null }),
    query: async (name, params) => {
      asked.push({ name, params });
      if (options.fails) throw new Error("graph down");
      return { rows: rows as never, note: null };
    },
    unlink: async () => 0,
    reset: async () => {},
  };
}

const on = (brain: Brain, listed: string[] | Error = ["triage_signals"]) => brainPrecedents({ brain, packsOf: async (repoPath) => { if (listed instanceof Error) throw listed; return repoPath === "/r/a" ? listed : []; } });

describe("brainPrecedents", () => {
  it("never asks the brain by default: a repository with no list, or without the pack in it, or no repository", async () => {
    const brain = fakeBrain([row()]);
    expect(await on(brain, [])("triage_signals", "Export", "/r/a", "t1")).toEqual([]);
    expect(await on(brain, ["risk_score"])("triage_signals", "Export", "/r/a", "t1")).toEqual([]);
    expect(await on(brain)("triage_signals", "Export", null, "t1")).toEqual([]);
    expect(await on(brain, new Error("no luna.yaml"))("triage_signals", "Export", "/r/a", "t1")).toEqual([]);
    expect(brain.asked).toEqual([]);
  });

  it("asks nothing of a brain that is off", async () => {
    const brain = fakeBrain([row()], { enabled: false });
    expect(await on(brain)("triage_signals", "Export", "/r/a", "t1")).toEqual([]);
    expect(brain.asked).toEqual([]);
  });

  it("asks the precedents query with the pack and the title, and maps the rows: the card's title, truth_source as truthSource", async () => {
    const brain = fakeBrain([row(), row({ question: "size", answer: "S", truth: "M", truth_source: "outcome", title: "Fix login", card: "card:old2" })]);
    expect(await on(brain)("triage_signals", "Export a report", "/r/a", "t1")).toEqual([
      { question: "kind", answer: "bug", truth: "feature", truthSource: "person", card: "Export CSV", decidedAt: "2026-10-03T08:15:00.000Z" },
      { question: "size", answer: "S", truth: "M", truthSource: "outcome", card: "Fix login", decidedAt: "2026-10-03T08:15:00.000Z" },
    ]);
    expect(brain.asked).toEqual([{ name: "precedents", params: { pack: "triage_signals", q: "Export a report" } }]);
  });

  it("leaves out the current card's own verdicts, a row with a missing column, and a truth source it does not know", async () => {
    const brain = fakeBrain([row({ card: "card:t1" }), row({ truth: null }), row({ answer: "" }), row({ title: null }), row({ truth_source: "guess" }), row({ title: "Kept" })]);
    expect((await on(brain)("triage_signals", "Export", "/r/a", "t1")).map((p) => p.card)).toEqual(["Kept"]);
    // With no card asking, nothing is left out by identity.
    expect((await on(brain)("triage_signals", "Export", "/r/a", null)).map((p) => p.card)).toEqual(["Export CSV", "Kept"]);
  });

  it("cuts each text to its cap and keeps the first six", async () => {
    const long = "x".repeat(300);
    const [first] = await on(fakeBrain([row({ question: long, answer: long, truth: long, title: long })]))("triage_signals", "Export", "/r/a", "t1");
    expect(first!.question).toHaveLength(60);
    expect(first!.answer).toHaveLength(60);
    expect(first!.truth).toHaveLength(60);
    expect(first!.card).toHaveLength(200);
    const many = Array.from({ length: 12 }, (_, i) => row({ title: `Card ${i}`, card: `card:c${i}` }));
    expect((await on(fakeBrain(many))("triage_signals", "Export", "/r/a", "t1")).map((p) => p.card)).toEqual(["Card 0", "Card 1", "Card 2", "Card 3", "Card 4", "Card 5"]);
  });

  it("gives nothing when the query fails", async () => {
    expect(await on(fakeBrain([row()], { fails: true }))("triage_signals", "Export", "/r/a", "t1")).toEqual([]);
  });
});
