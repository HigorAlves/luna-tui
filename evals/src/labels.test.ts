import { PACKS } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import { checksOf, labelOfAnswer, matches, rubricOf } from "./labels.ts";

describe("labels", () => {
  it("turns a label into checks: equals, oneOf for an array, between ±0.5 for a score", () => {
    expect(checksOf({ cause: { choice: ["product_bug", "test_bug"] }, worth: { value: true }, risk: { score: 2 }, fmt: { choice: "text" } })).toEqual([
      { kind: "oneOf", path: "cause.choice", values: ["product_bug", "test_bug"] },
      { kind: "equals", path: "worth.value", value: true },
      { kind: "between", path: "risk.score", min: 1.5, max: 2.5 },
      { kind: "equals", path: "fmt.choice", value: "text" },
    ]);
  });

  it("reads the label an answer is, without its confidence", () => {
    expect(labelOfAnswer({ worth: { value: true, p: 0.9 }, cause: { choice: "env_flake", confidence: 0.8 }, risk: { score: 1.4, confidence: 0.5 } })).toEqual({ worth: { value: true }, cause: { choice: "env_flake" }, risk: { score: 1.4 } });
  });

  it("matches an answer to a label: exact, one of, a score within half a level; null for an empty label", () => {
    const answer = { cause: { choice: "test_bug", confidence: 0.9 }, risk: { score: 1.6, confidence: 0.7 } };
    expect(matches(answer, { cause: { choice: ["product_bug", "test_bug"] }, risk: { score: 2 } })).toBe(true);
    expect(matches(answer, { cause: { choice: "env_flake" } })).toBe(false);
    expect(matches(answer, { risk: { score: 0 } })).toBe(false);
    expect(matches(answer, {})).toBeNull();
  });

  it("writes a rubric from the pack's own instructions, and says when no label is there", () => {
    expect(rubricOf(PACKS.worth_learning, { worth: { value: true } })).toBe(`worth: ${(PACKS.worth_learning.questions.worth as { instructions: string }).instructions}`);
    expect(rubricOf(PACKS.e2e_failure_cause, null)).toMatch(/Labels: product_bug .*env_flake .*Awaiting a label/s);
  });
});
