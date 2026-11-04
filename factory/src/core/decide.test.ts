import { PACKS, type StageInput } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import { decisionSummary, renderDecision, stateOf } from "./decide.ts";

const questions = PACKS.issue_classify.questions;

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

describe("decisionSummary", () => {
  it("is one line per question with its confidence, and names the ones below the pack's bar", () => {
    const answer = { kind: { choice: "bug", confidence: 0.91 }, area: { choice: "board", confidence: 0.62 }, ready: { value: true, p: 0.83 }, size: { score: 1.4, confidence: 0.75 } };
    expect(decisionSummary(questions, answer, 0.7)).toBe("kind bug (0.91) · area board (0.62) · ready yes (p 0.83) · size 1.4 (0.75) · below 0.7: area");
  });
});
