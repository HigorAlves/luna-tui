import { describe, expect, it } from "vitest";

import { blockerSetKey, nextRound } from "./finding-sets.ts";

const f = (title: string, severity: string, over: Record<string, unknown> = {}) => ({ path: "a.ts", line: 1, severity, title, body: "b", confidence: 0.9, ...over });

describe("the set of blocker findings", () => {
  it("is the ids of the blockers, in any order, and nothing for should_fix and nit", () => {
    const a = f("one", "blocker");
    const b = f("two", "bug", { line: 9 });
    expect(blockerSetKey([a, b])).toBe(blockerSetKey([b, a]));
    expect(blockerSetKey([a, f("soft", "should_fix", { line: 4 })])).not.toBe(blockerSetKey([a, b]));
    expect(blockerSetKey([a, f("soft", "nit", { line: 4 })])).toBe(blockerSetKey([a]));
    expect(blockerSetKey([f("n", "nit")])).toBeNull();
  });

  it("counts only the blockers the verdict counts: confidence 0.8 or more", () => {
    const sure = f("one", "blocker");
    expect(blockerSetKey([sure, f("unsure", "blocker", { line: 8, confidence: 0.5 })])).toBe(blockerSetKey([sure]));
    expect(blockerSetKey([f("unsure", "blocker", { confidence: 0.79 })])).toBeNull();
  });

  it("uses the id a finding carries, so a reworded body is the same finding", () => {
    expect(blockerSetKey([f("x", "blocker", { id: "F1" })])).toBe(blockerSetKey([f("y", "blocker", { id: "F1", body: "other" })]));
  });
});

describe("rounds spent on one set", () => {
  it("sends a new set to Build and counts the round", () => {
    expect(nextRound(undefined, "k1", 1)).toEqual({ escalate: false, set: { key: "k1", rounds: 1 } });
  });
  it("escalates when the same set comes back after the allowed rounds", () => {
    expect(nextRound({ key: "k1", rounds: 1 }, "k1", 1)).toEqual({ escalate: true, set: { key: "k1", rounds: 1 } });
    expect(nextRound({ key: "k1", rounds: 1 }, "k1", 2)).toEqual({ escalate: false, set: { key: "k1", rounds: 2 } });
  });
  it("starts its own count for a different set", () => {
    expect(nextRound({ key: "k1", rounds: 1 }, "k2", 1)).toEqual({ escalate: false, set: { key: "k2", rounds: 1 } });
  });
});
