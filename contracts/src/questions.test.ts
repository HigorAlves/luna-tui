// Decision packs: the questions are data, the answer schema is derived from them, and
// triage_signals asks what intake needs to label and route an issue.
import { describe, expect, it } from "vitest";

import { ENGINES, PACKS, PACK_LIMITS, PlanContext, StageInput, answerSchema, applyPolicy, classificationLine, classificationOf, coverageGaps, riskLevelOf } from "./index.ts";

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

describe("the triage_signals pack", () => {
  const pack = PACKS.triage_signals;

  it("asks kind, area, ready, size, urgency, risk, and whether to archive and why", () => {
    expect(Object.keys(pack.questions)).toEqual(["kind", "area", "ready", "size", "urgency", "risk", "archive", "archive_reason"]);
    expect(pack.questions.urgency).toMatchObject({ type: "score", rubric: { low: expect.any(String), normal: expect.any(String), high: expect.any(String), urgent: expect.any(String) } });
    expect(pack.questions.risk).toMatchObject({ type: "score", rubric: { none: expect.any(String), low: expect.any(String), medium: expect.any(String), high: expect.any(String) } });
    expect(pack.questions.archive).toMatchObject({ type: "yesno" });
    expect(Object.keys((pack.questions.archive_reason as { criteria: Record<string, string> }).criteria)).toEqual(["none", "duplicate", "out_of_scope", "stale", "not_actionable"]);
    expect(Object.keys(pack.policy).sort()).toEqual(Object.keys(pack.questions).sort());
    expect(pack.policy.archive).toEqual({ proceed: 0.9, flag: 0.7 });
  });

  it("is a decision: no role, tools or template, and a policy bar per question", () => {
    expect(pack).toMatchObject({ kind: "decision", writable: false });
    expect(pack).not.toHaveProperty("minConfidence");
    expect(pack).not.toHaveProperty("agent");
    expect(pack).not.toHaveProperty("access");
    expect(pack).not.toHaveProperty("template");
    expect(ENGINES.jev.model).toBe("typesafe/jev");
    expect(PACK_LIMITS.triage_signals).toEqual({ maxTurns: pack.maxTurns, timeoutMs: pack.timeoutMs, writable: false });
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
    const answer = { kind: { choice: "feature", confidence: 0.8 }, area: { choice: "machine", confidence: 0.75 }, ready: { value: false, p: 0.3 }, size: { score: 1.5, confidence: 0.7 }, urgency: { score: 1, confidence: 0.7 }, risk: { score: 1, confidence: 0.7 }, archive: { value: false, p: 0.1 }, archive_reason: { choice: "none", confidence: 0.9 } };
    expect(pack.answer.parse(answer)).toEqual(answer);
  });

  it("reads the issue from the stage input's context", () => {
    const input = { schema: 3, stage: "triage_signals", pack: "triage_signals", attempt: 1, task: { id: "t", title: "t", description: "", criteria: [], repoPath: "", branch: "", source: null }, plan: null, decisions: [], priorFindings: [], limits: { maxTurns: 1, timeoutMs: 1 }, env: {} };
    const issue = { title: "Board crashes on resize", description: "Steps: resize the terminal.", labels: ["bug"], source: "jira:HAR-12" };
    expect(StageInput.parse({ ...input, context: { projectContext: null, issue } }).context.issue).toEqual(issue);
    expect(StageInput.parse({ ...input, context: { projectContext: null, issue: { title: "t", description: "" } } }).context.issue).toEqual({ title: "t", description: "" });
    expect(StageInput.safeParse({ ...input, context: { projectContext: null, issue: { title: "t" } } }).success).toBe(false);
  });
});

describe("the plan stage's decision packs", () => {
  it("risk_score asks blast radius, reversibility and data sensitivity as three-level scores", () => {
    const pack = PACKS.risk_score;
    expect(pack).toMatchObject({ kind: "decision", writable: false, maxTurns: 1 });
    expect(Object.keys(pack.questions)).toEqual(["blast_radius", "reversibility", "data_sensitivity"]);
    for (const q of Object.values(pack.questions)) expect(q).toMatchObject({ type: "score" });
    expect(Object.keys((pack.questions.blast_radius as { rubric: object }).rubric)).toEqual(["one", "some", "wide"]);
  });

  it("coverage_check asks whether scenarios pin their criteria, how much they overlap and whether a criterion is untestable", () => {
    const pack = PACKS.coverage_check;
    expect(Object.keys(pack.questions)).toEqual(["pins", "redundancy", "untestable"]);
    expect(pack.questions.pins).toMatchObject({ type: "yesno" });
    expect(pack.questions.redundancy).toMatchObject({ type: "score", rubric: { none: expect.any(String), some: expect.any(String), heavy: expect.any(String) } });
    expect(pack.questions.untestable).toMatchObject({ type: "yesno" });
  });

  it("plan_check asks whether the plan fits the record, its slices cover the criteria, its rollback can be followed and its slices stay inside the code map", () => {
    const pack = PACKS.plan_check;
    expect(Object.keys(pack.questions)).toEqual(["fits_record", "slices_cover_criteria", "rollback_stated", "touchpoints_in_map"]);
    expect(pack.questions.touchpoints_in_map).toMatchObject({ type: "yesno", instructions: expect.stringContaining("code map") });
    expect(pack.questions.fits_record).toMatchObject({ type: "score", rubric: { no: expect.any(String), partly: expect.any(String), yes: expect.any(String) } });
  });

  it("red_check asks whether the red is for the right reason and the test asserts the behaviour; scope_check asks five yes/no questions over the facts", () => {
    expect(Object.keys(PACKS.red_check.questions)).toEqual(["right_reason", "not_tautological"]);
    expect(PACKS.red_check.questions.right_reason).toMatchObject({ type: "yesno", instructions: expect.stringContaining("missing import") });
    expect(Object.keys(PACKS.scope_check.questions)).toEqual(["planned_or_declared", "no_new_dependency", "no_secret_or_pii", "no_test_removed", "no_todo"]);
    for (const q of Object.values(PACKS.scope_check.questions)) expect(q.type).toBe("yesno");
    for (const pack of [PACKS.red_check, PACKS.scope_check]) {
      expect(pack.engines).toEqual({ default: "jev", allowed: ["jev", "claude:haiku", "codex:luna"], fallback: ["claude:haiku"] });
      expect(Object.keys(pack.policy).sort()).toEqual(Object.keys(pack.questions).sort());
      expect(PACK_LIMITS[pack.id]).toEqual({ maxTurns: 1, timeoutMs: pack.timeoutMs, writable: false });
    }
  });

  it("finding_classify asks one severity choice (blocker, should_fix, nit) and e2e_failure_cause one cause choice (product_bug, test_bug, env_flake), both decisions on the check context", () => {
    const classify = PACKS.finding_classify;
    const cause = PACKS.e2e_failure_cause;
    expect(Object.keys(classify.questions)).toEqual(["severity"]);
    expect(classify.questions.severity).toMatchObject({ type: "choice", criteria: { blocker: expect.any(String), should_fix: expect.any(String), nit: expect.any(String) } });
    expect(Object.keys(cause.questions)).toEqual(["cause"]);
    expect(cause.questions.cause).toMatchObject({ type: "choice", criteria: { product_bug: expect.any(String), test_bug: expect.any(String), env_flake: expect.any(String) } });
    for (const pack of [classify, cause]) {
      expect(pack.kind).toBe("decision");
      expect(pack.engines).toEqual({ default: "jev", allowed: ["jev", "claude:haiku", "codex:luna"], fallback: ["claude:haiku"] });
      expect(Object.keys(pack.policy).sort()).toEqual(Object.keys(pack.questions).sort());
      expect(PACK_LIMITS[pack.id]).toEqual({ maxTurns: 1, timeoutMs: pack.timeoutMs, writable: false });
    }
  });

  it("all three run on Jev by default and a small Claude or Codex model when it is absent, with a bar per question", () => {
    for (const pack of [PACKS.risk_score, PACKS.coverage_check, PACKS.plan_check]) {
      expect(pack.engines).toEqual({ default: "jev", allowed: ["jev", "claude:haiku", "codex:luna"], fallback: ["claude:haiku"] });
      expect(Object.keys(pack.policy).sort()).toEqual(Object.keys(pack.questions).sort());
      expect(PACK_LIMITS[pack.id]).toEqual({ maxTurns: 1, timeoutMs: pack.timeoutMs, writable: false });
    }
  });

  it("riskLevelOf adds the three levels (a score rounds to one, plus 1): 3 to 4 low, 5 to 6 medium, 7 to 9 high", () => {
    const at = (a: number, b: number, c: number) => riskLevelOf({ blast_radius: { score: a }, reversibility: { score: b }, data_sensitivity: { score: c } });
    expect(at(0, 0, 0)).toBe("low");
    expect(at(1, 0, 0)).toBe("low"); // sum 4
    expect(at(1, 1, 0)).toBe("medium"); // 5
    expect(at(1, 1, 1)).toBe("medium"); // 6
    expect(at(2, 1, 1)).toBe("high"); // 7
    expect(at(2, 2, 2)).toBe("high"); // 9
    expect(at(0.4, 0.4, 0.4)).toBe("low"); // rounds down
    expect(at(1.5, 1.5, 1.5)).toBe("high"); // rounds up to 2 each
  });

  it("coverageGaps lists the criteria no case names, matched after trimming", () => {
    const cases = [{ criterion: "bad password shows an error" }, { criterion: " locks after five failures " }, { criterion: null }];
    expect(coverageGaps(["bad password shows an error ", "locks after five failures", "logs the attempt"], cases)).toEqual(["logs the attempt"]);
    expect(coverageGaps([], cases)).toEqual([]);
    expect(coverageGaps(["c"], [])).toEqual(["c"]);
  });

  it("a plan context carries the record, the plan, the scenarios and the gaps, and rides the stage input's context", () => {
    const plan = { record: null, brief: "b", criteria: ["c"], assumptions: [], slices: [{ title: "s", est_loc: 5, touchpoints: ["a.ts"], acceptance: ["ok"] }], cases: [{ title: "t", criterion: "c", approach: "a" }], gaps: [], round: 1 };
    expect(PlanContext.parse(plan)).toEqual(plan);
    const input = { schema: 3, stage: "plan_check", pack: "plan_check", attempt: 1, task: { id: "t", title: "t", description: "", criteria: [], repoPath: "", branch: "", source: null }, plan: null, decisions: [], priorFindings: [], limits: { maxTurns: 1, timeoutMs: 1 }, env: {} };
    expect(StageInput.parse({ ...input, context: { projectContext: null, plan } }).context.plan).toEqual(plan);
  });
});

describe("an issue's classification", () => {
  const answer = { kind: { choice: "question", confidence: 0.97 }, area: { choice: "machine", confidence: 0.9 }, ready: { value: false, p: 0.15 }, size: { score: 0.2, confidence: 0.8 }, urgency: { score: 1, confidence: 0.85 }, risk: { score: 0.9, confidence: 0.9 }, archive: { value: false, p: 0.05 }, archive_reason: { choice: "none", confidence: 0.95 } };

  it("keeps each pick and the least sure answer's confidence, a yes/no's being its distance from a coin toss", () => {
    const at = new Date("2026-11-03T12:00:00Z");
    expect(classificationOf(answer, "typesafe-ai/jev", at)).toEqual({
      kind: "question", kindConfidence: 0.97, area: "machine", ready: false, size: 0.2, urgency: 1, risk: 0.9, archive: false, archiveReason: "none", confidence: 0.8, at: "2026-11-03T12:00:00.000Z", model: "typesafe-ai/jev",
      signals: {
        kind: { answer: "question", confidence: 0.97 }, area: { answer: "machine", confidence: 0.9 }, ready: { answer: false, confidence: 0.85 }, size: { answer: 0.2, confidence: 0.8 },
        urgency: { answer: 1, confidence: 0.85 }, risk: { answer: 0.9, confidence: 0.9 }, archive: { answer: false, confidence: 0.95 }, archive_reason: { answer: "none", confidence: 0.95 },
      },
    });
    expect(classificationOf({ ...answer, ready: { value: true, p: 0.6 } }, "m", at).confidence).toBeCloseTo(0.6, 10);
  });

  it("reads in one line, the size by its rubric level", () => {
    const c = classificationOf(answer, "typesafe-ai/jev", new Date(0));
    expect(classificationLine(c)).toBe("question · machine · not ready · size tiny · lowest confidence 0.80 (typesafe-ai/jev) · urgency normal · risk low");
    expect(classificationLine({ ...c, ready: true, size: 2.6 })).toMatch(/· ready · size large ·/);
    expect(classificationLine({ ...c, archive: true, archiveReason: "duplicate" })).toMatch(/ · archive\? duplicate$/);
    expect(classificationLine({ kind: "bug", area: "board", ready: true, size: 1, confidence: 0.9, at: "", model: "m" })).toBe("bug · board · ready · size small · lowest confidence 0.90 (m)");
  });
});

describe("confidence policy", () => {
  const pack = PACKS.triage_signals;
  const answer = { kind: { choice: "question", confidence: 0.9 }, area: { choice: "machine", confidence: 0.55 }, ready: { value: false, p: 0.3 }, size: { score: 0.2, confidence: 0.8 }, urgency: { score: 1, confidence: 0.85 }, risk: { score: 1, confidence: 0.9 }, archive: { value: false, p: 0.02 }, archive_reason: { choice: "none", confidence: 0.95 } };
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
    expect(v.verdicts).toEqual({ kind: "proceed", area: "flag", ready: "proceed", size: "proceed", urgency: "proceed", risk: "proceed", archive: "proceed", archive_reason: "proceed" }); // ready: max(0.3, 0.7) = 0.7, at the proceed bar
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
