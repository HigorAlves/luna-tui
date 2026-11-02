// Decision packs: the questions are data, the answer schema is derived from them, and
// issue_classify asks what intake needs to label and route an issue.
import { describe, expect, it } from "vitest";

import { ENGINES, PACKS, PACK_LIMITS, StageInput, answerSchema } from "./index.ts";

describe("the answer schema of a question set", () => {
  const schema = answerSchema({
    kind: { type: "choice", criteria: { bug: "broken", feature: "new" } },
    ready: { type: "yesno", instructions: "Is it ready?", threshold: 0.6 },
    size: { type: "score", instructions: "How big?", rubric: { tiny: "a line", small: "a file", large: "a subsystem" } },
  });

  it("is a choice and its confidence, a boolean and P(yes), a score and its confidence", () => {
    const answer = { kind: { choice: "bug", confidence: 0.9 }, ready: { value: true, p: 0.7 }, size: { score: 1.4, confidence: 0.8 } };
    expect(schema.parse(answer)).toEqual(answer);
  });

  it("rejects a label outside the criteria, a probability above one, a score past the rubric and a missing question", () => {
    expect(schema.safeParse({ kind: { choice: "chore", confidence: 0.9 }, ready: { value: true, p: 0.7 }, size: { score: 1, confidence: 0.8 } }).success).toBe(false);
    expect(schema.safeParse({ kind: { choice: "bug", confidence: 1.2 }, ready: { value: true, p: 0.7 }, size: { score: 1, confidence: 0.8 } }).success).toBe(false);
    expect(schema.safeParse({ kind: { choice: "bug", confidence: 0.9 }, ready: { value: true, p: 0.7 }, size: { score: 2.5, confidence: 0.8 } }).success).toBe(false);
    expect(schema.safeParse({ kind: { choice: "bug", confidence: 0.9 }, ready: { value: true, p: 0.7 } }).success).toBe(false);
  });

  it("refuses a choice with no criteria and a score with fewer than two levels", () => {
    expect(() => answerSchema({ kind: { type: "choice", criteria: {} } })).toThrow(/kind/);
    expect(() => answerSchema({ size: { type: "score", instructions: "How big?", rubric: { tiny: "a line" } } })).toThrow(/size/);
  });
});

describe("the issue_classify pack", () => {
  const pack = PACKS.issue_classify;

  it("is a decision on jev: no role, tools or template, and a 0.7 confidence floor", () => {
    expect(pack).toMatchObject({ kind: "decision", writable: false, engines: { default: "jev", allowed: ["jev"] }, minConfidence: 0.7 });
    expect(pack).not.toHaveProperty("agent");
    expect(pack).not.toHaveProperty("access");
    expect(pack).not.toHaveProperty("template");
    expect(ENGINES.jev.model).toBe("typesafe/jev");
    expect(PACK_LIMITS.issue_classify).toEqual({ maxTurns: pack.maxTurns, timeoutMs: pack.timeoutMs, writable: false });
  });

  it("asks the kind, the area, whether it is ready and its size, and answers in the schema derived from them", () => {
    const { kind, area, ready, size } = pack.questions;
    expect(kind).toMatchObject({ type: "choice", criteria: { bug: expect.any(String), feature: expect.any(String), chore: expect.any(String), question: expect.any(String) } });
    expect(Object.keys(area?.type === "choice" ? area.criteria : {})).toEqual(["board", "machine", "factory", "contracts", "site"]);
    expect(ready).toMatchObject({ type: "yesno", instructions: expect.stringMatching(/acceptance criteria/) });
    expect(size?.type === "score" && Object.keys(size.rubric).length).toBeGreaterThanOrEqual(2);
    const answer = { kind: { choice: "feature", confidence: 0.8 }, area: { choice: "machine", confidence: 0.75 }, ready: { value: false, p: 0.3 }, size: { score: 1.5, confidence: 0.7 } };
    expect(pack.answer.parse(answer)).toEqual(answer);
  });

  it("reads the issue from the stage input's context", () => {
    const input = { schema: 3, stage: "issue_classify", pack: "issue_classify", attempt: 1, task: { id: "t", title: "t", description: "", criteria: [], repoPath: "", branch: "", source: null }, plan: null, decisions: [], priorFindings: [], limits: { maxTurns: 1, timeoutMs: 1 }, env: {} };
    const issue = { title: "Board crashes on resize", description: "Steps: resize the terminal.", labels: ["bug"], source: "jira:HAR-12" };
    expect(StageInput.parse({ ...input, context: { projectContext: null, issue } }).context.issue).toEqual(issue);
    expect(StageInput.parse({ ...input, context: { projectContext: null, issue: { title: "t", description: "" } } }).context.issue).toEqual({ title: "t", description: "" });
    expect(StageInput.safeParse({ ...input, context: { projectContext: null, issue: { title: "t" } } }).success).toBe(false);
  });
});
