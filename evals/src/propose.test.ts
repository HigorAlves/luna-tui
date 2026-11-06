import { PACKS } from "@hardness/contracts";
import type { DecisionRecord } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import { answersOf, proposeBars, renderBars } from "./propose.ts";

const record = (id: string, confidence: number, right: boolean, kind: "person" | "fact" | "outcome" = "person"): DecisionRecord => ({
  schema: 1, id, pack: "worth_learning", engine: "claude:haiku", model: "m", at: "2026-11-04T12:00:00.000Z", client: "ship",
  context: { ship: { text: "SECRET-LOOKING CONTEXT MUST NOT BE PRINTED" } }, answer: { worth: { value: true, p: confidence } }, verdicts: { worth: "proceed" }, overall: "proceed", traceId: null, origin: "machine",
  truth: { label: { worth: { value: right } }, source: "x", at: "2026-11-05T00:00:00.000Z", kind },
});

describe("answersOf", () => {
  it("takes the labelled answers per question, a yes/no's confidence being the stronger side of p, and leaves outcomes out unless asked", () => {
    const records = [record("a", 0.9, true), record("b", 0.8, false, "fact"), record("c", 0.7, true, "outcome")];
    expect(answersOf("worth_learning", records).worth).toEqual([{ confidence: 0.9, right: true }, { confidence: 0.8, right: false }]);
    expect(answersOf("worth_learning", records, { withOutcome: true }).worth).toHaveLength(3);
  });
});

describe("proposeBars", () => {
  const today = { proceed: 0.7, flag: 0.5 };
  const answers = (list: Array<[number, boolean]>) => list.map(([confidence, right]) => ({ confidence, right }));

  it("says too few under twenty labelled answers and proposes nothing", () => {
    const out = proposeBars(answers([[0.9, true]]), today);
    expect(out.proposal).toBeNull();
    expect(out.reason).toBe("too few: 1 of 20 labelled answers");
  });

  it("proposes the lowest bar whose acted-on accuracy reaches the target with at least twenty answers at or above it, and the flag bar the same distance below", () => {
    const list: Array<[number, boolean]> = [
      ...Array.from({ length: 10 }, (): [number, boolean] => [0.55, false]),
      ...Array.from({ length: 5 }, (): [number, boolean] => [0.7, true]),
      ...Array.from({ length: 25 }, (): [number, boolean] => [0.9, true]),
    ];
    const out = proposeBars(answers(list), today, { target: 0.9 });
    expect(out.proposal).toEqual({ proceed: 0.6, flag: 0.4 });
    const row = out.candidates.find((c) => c.bar === 0.6)!;
    expect(row).toMatchObject({ atOrAbove: 30, right: 30 });
    expect(row.share).toBeCloseTo(30 / 40);
    expect(out.candidates.find((c) => c.bar === 0.55)).toMatchObject({ atOrAbove: 40, right: 30 });
    expect(row.interval![1]).toBe(100);
    expect(out.candidates.map((c) => c.bar)[0]).toBe(0.5);
    expect(out.candidates.at(-1)!.bar).toBe(0.95);
  });

  it("proposes nothing when no bar reaches the target, and says so", () => {
    const out = proposeBars(answers(Array.from({ length: 30 }, (_, i): [number, boolean] => [0.9, i % 2 === 0])), today);
    expect(out.proposal).toBeNull();
    expect(out.reason).toMatch(/no bar/);
  });
});

describe("renderBars", () => {
  it("prints the evidence, the luna.yaml line marked proposed and not applied, a pin beside the numbers, and no context", () => {
    const records = Array.from({ length: 30 }, (_, i) => record(`r${i}`, 0.9, true));
    const text = renderBars("worth_learning", records, { today: PACKS.worth_learning.policy, pin: { engine: "jev", since: "2026-11-05", why: "kept by the owner" } }).join("\n");
    expect(text).toContain("worth");
    expect(text).toContain("30 labelled answers");
    expect(text).toContain("pinned on jev");
    expect(text).toContain("never moves");
    expect(text).toMatch(/decisions\.worth_learning\.worth: \{ proceed: 0\.\d+, flag: 0\.\d+ \}/);
    expect(text).toContain("proposed, not applied");
    expect(text).not.toContain("SECRET-LOOKING");
  });
});
