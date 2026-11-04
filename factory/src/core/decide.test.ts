import { PACKS, type StageInput } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import { decisionSummary, renderDecision, renderPlan, stateOf } from "./decide.ts";

const questions = PACKS.triage_signals.questions;

describe("renderDecision", () => {
  it("puts the state first, then every question with its type and labels, then the answer rule", () => {
    const text = renderDecision(questions, { title: "Board panics on key", description: "Pressing j on an empty list panics." });
    expect(text).toContain("# State\n");
    expect(text).toContain("Board panics on key");
    expect(text).toContain("## kind (choice)");
    expect(text).toContain("- bug: Something that works, or should work, is broken");
    expect(text).toContain("## ready (yes or no)");
    expect(text).toContain("## size (score)");
    expect(text).toContain("- 0 tiny:");
    expect(text).toMatch(/Answer only with the JSON object the schema asks for/);
    expect(text).toMatch(/confidence/);
  });
});

describe("stateOf", () => {
  it("prefers context.issue and falls back to the task's title and description", () => {
    const base = { task: { title: "T", description: "D" }, context: {} } as unknown as StageInput;
    expect(stateOf(base)).toEqual({ title: "T", description: "D" });
    expect(stateOf({ ...base, context: { issue: { title: "I", description: "E" } } } as unknown as StageInput)).toEqual({ title: "I", description: "E" });
  });
});

describe("a plan as the state", () => {
  const plan = {
    record: { source: "github", kind: "bug", goal: "Stop the panic", size: "small", urgency: "high", risk: "low", signals: {}, qa: [], decision: "plan", reason: "one function", at: "2026-11-04T00:00:00.000Z", model: "m" },
    brief: "Guard the empty list in the key handler",
    criteria: ["no panic on j", "list stays selected"],
    assumptions: ["board only"],
    slices: [{ title: "guard j", est_loc: 12, touchpoints: ["board/src/keys.rs"], acceptance: ["no panic on j"] }],
    rollback: "Revert the commit; nothing else changes.",
    cases: [{ title: "j on empty", criterion: "no panic on j", approach: "cargo test keys::empty" }],
    gaps: ["list stays selected"],
  };
  const input = { task: { title: "t", description: "d" }, context: { plan } } as unknown as StageInput;

  it("renders the record, brief, criteria, slices, rollback, scenarios by criterion and the gaps", () => {
    const text = renderPlan(plan as never);
    expect(text).toContain("Goal: Stop the panic");
    expect(text).toContain("Brief: Guard the empty list in the key handler");
    expect(text).toContain("Criteria:\n- no panic on j\n- list stays selected");
    expect(text).toContain("1. guard j (~12 LOC; touches board/src/keys.rs): no panic on j");
    expect(text).toContain("Rollback: Revert the commit; nothing else changes.");
    expect(text).toContain("Scenarios:\n- no panic on j\n  - j on empty: cargo test keys::empty");
    expect(text).toContain("No scenario names these criteria:\n- list stays selected");
  });

  it("is the state a decision sees, ahead of the questions", () => {
    const state = stateOf(input);
    expect(state.title).toBe("Guard the empty list in the key handler");
    const text = renderDecision(PACKS.plan_check.questions, state);
    expect(text.indexOf("Brief: Guard the empty list")).toBeGreaterThan(-1);
    expect(text.indexOf("Brief:")).toBeLessThan(text.indexOf("# Questions"));
    expect(text).toContain("## fits_record (score)");
  });
});

describe("decisionSummary", () => {
  it("is one line per question with its confidence, and names the ones below the pack's bar", () => {
    const answer = { kind: { choice: "bug", confidence: 0.91 }, area: { choice: "board", confidence: 0.62 }, ready: { value: true, p: 0.83 }, size: { score: 1.4, confidence: 0.75 } };
    expect(decisionSummary(questions, answer, 0.7)).toBe("kind bug (0.91) · area board (0.62) · ready yes (p 0.83) · size 1.4 (0.75) · below 0.7: area");
  });
});
