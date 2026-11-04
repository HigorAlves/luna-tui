// Decision packs: the questions are data, the answer schema is derived from them, and
// issue_classify asks what intake needs to label and route an issue.
import { describe, expect, it } from "vitest";

import { ENGINES, PACKS, PACK_LIMITS, StageInput, answerSchema, applyPolicy, classificationLine, classificationOf } from "./index.ts";

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

  it("is a decision: no role, tools or template, and a policy bar per question", () => {
    expect(pack).toMatchObject({ kind: "decision", writable: false });
    expect(pack).not.toHaveProperty("minConfidence");
    expect(pack).not.toHaveProperty("agent");
    expect(pack).not.toHaveProperty("access");
    expect(pack).not.toHaveProperty("template");
    expect(ENGINES.jev.model).toBe("typesafe/jev");
    expect(PACK_LIMITS.issue_classify).toEqual({ maxTurns: pack.maxTurns, timeoutMs: pack.timeoutMs, writable: false });
  });

  it("runs on Jev by default and on a small Claude or Codex model when Jev is absent", () => {
    expect(pack.engines).toEqual({ default: "jev", allowed: ["jev", "claude:haiku", "codex:luna"], fallback: ["claude:haiku"] });
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

describe("an issue's classification", () => {
  const answer = { kind: { choice: "question", confidence: 0.97 }, area: { choice: "machine", confidence: 0.9 }, ready: { value: false, p: 0.15 }, size: { score: 0.2, confidence: 0.8 } };

  it("keeps each pick and the least sure answer's confidence, a yes/no's being its distance from a coin toss", () => {
    const at = new Date("2026-11-03T12:00:00Z");
    expect(classificationOf(answer, "typesafe-ai/jev", at)).toEqual({ kind: "question", kindConfidence: 0.97, area: "machine", ready: false, size: 0.2, confidence: 0.8, at: "2026-11-03T12:00:00.000Z", model: "typesafe-ai/jev" });
    expect(classificationOf({ ...answer, ready: { value: true, p: 0.6 } }, "m", at).confidence).toBeCloseTo(0.6, 10);
  });

  it("reads in one line, the size by its rubric level", () => {
    const c = classificationOf(answer, "typesafe-ai/jev", new Date(0));
    expect(classificationLine(c)).toBe("question · machine · not ready · size tiny · lowest confidence 0.80 (typesafe-ai/jev)");
    expect(classificationLine({ ...c, ready: true, size: 2.6 })).toMatch(/· ready · size large ·/);
  });
});

describe("confidence policy", () => {
  const pack = PACKS.issue_classify;
  const answer = { kind: { choice: "question", confidence: 0.9 }, area: { choice: "machine", confidence: 0.55 }, ready: { value: false, p: 0.3 }, size: { score: 0.2, confidence: 0.8 } };
  it("gives every question a proceed and a flag bar, flag below proceed, both in (0, 1]", () => {
    for (const [name, p] of Object.entries(pack.policy)) {
      expect(p.flag, name).toBeGreaterThan(0);
      expect(p.flag, name).toBeLessThanOrEqual(p.proceed);
      expect(p.proceed, name).toBeLessThanOrEqual(1);
    }
    expect(Object.keys(pack.policy).sort()).toEqual(Object.keys(pack.questions).sort());
  });
  it("judges each answer against its own bar and the whole answer by its worst question", () => {
    const v = applyPolicy(pack, answer);
    expect(v.verdicts).toEqual({ kind: "proceed", area: "flag", ready: "proceed", size: "proceed" }); // ready: max(0.3, 0.7) = 0.7, at the proceed bar
    expect(v.overall).toBe("flag");
    expect(v.below).toEqual(["area"]);
  });
  it("asks a person when a question is under its flag bar", () => {
    expect(applyPolicy(pack, { ...answer, area: { choice: "machine", confidence: 0.3 } }).overall).toBe("ask");
  });
  it("takes a repo's overrides question by question", () => {
    const v = applyPolicy(pack, answer, { area: { proceed: 0.5 } });
    expect(v.verdicts.area).toBe("proceed");
    expect(v.overall).toBe("proceed");
  });
});
