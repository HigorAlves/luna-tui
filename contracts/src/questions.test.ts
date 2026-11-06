// Decision packs: the questions are data, the answer schema is derived from them, and
// triage_signals asks what intake needs to label and route an issue.
import { decisionEngines } from "./decision-defaults.ts";
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

const V2_ANSWER = {
  kind: { choice: "bug", confidence: 0.9 }, type_of_work: { choice: "backend", confidence: 0.8 }, ready: { value: true, p: 0.9 }, size: { choice: "S", confidence: 0.7 },
  who: { score: 1, confidence: 0.8 }, what: { score: 1, confidence: 0.8 }, impact: { score: 1, confidence: 0.75 }, time: { score: 0, confidence: 0.9 }, demand: { score: 0, confidence: 0.9 },
  risk_prelim: { choice: "low", confidence: 0.9 }, archive: { value: false, p: 0.05 }, archive_reason: { choice: "none", confidence: 0.95 },
};

describe("the triage_signals pack", () => {
  const pack = PACKS.triage_signals;

  it("asks the diagram's signals: kind, type of work, ready, five sizes, five urgency sub-scores, preliminary risk, archive and why", () => {
    expect(Object.keys(pack.questions)).toEqual(["kind", "type_of_work", "ready", "size", "who", "what", "impact", "time", "demand", "risk_prelim", "archive", "archive_reason"]);
    expect(Object.keys((pack.questions.kind as { criteria: object }).criteria)).toEqual(["bug", "feature", "task", "chore", "question", "incident"]);
    expect(Object.keys((pack.questions.type_of_work as { criteria: object }).criteria)).toEqual(["frontend", "backend", "infra", "data", "docs", "mixed"]);
    expect(Object.keys((pack.questions.size as { criteria: object }).criteria)).toEqual(["XS", "S", "M", "L", "XL"]);
    for (const q of ["who", "what", "impact", "time", "demand"]) expect(Object.keys((pack.questions[q] as { rubric: object }).rubric)).toHaveLength(3);
    expect(Object.keys((pack.questions.risk_prelim as { criteria: object }).criteria)).toEqual(["low", "medium", "high"]);
    expect(pack.questions.archive).toMatchObject({ type: "yesno" });
    expect(Object.keys((pack.questions.archive_reason as { criteria: Record<string, string> }).criteria)).toEqual(["none", "duplicate", "out_of_scope", "stale", "not_actionable"]);
    expect(pack.questions).not.toHaveProperty("area");
    expect(pack.questions).not.toHaveProperty("urgency");
    expect(Object.keys(pack.policy).sort()).toEqual(Object.keys(pack.questions).sort());
  });

  it("bars each question as the diagram's confidence config does, the flag band 0.15 under", () => {
    expect(pack.policy.kind).toEqual({ proceed: 0.8, flag: 0.65 });
    expect(pack.policy.size).toEqual({ proceed: 0.6, flag: 0.45 });
    expect(pack.policy.who).toEqual({ proceed: 0.7, flag: 0.55 });
    expect(pack.policy.risk_prelim).toEqual({ proceed: 0.85, flag: 0.7 });
    expect(pack.policy.archive).toEqual({ proceed: 0.9, flag: 0.75 });
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
    expect(pack.engines).toEqual({ ...decisionEngines(pack.id), allowed: ["jev", "claude:haiku", "codex:luna"] });
  });

  it("answers in the schema derived from its questions", () => {
    expect(pack.questions.ready).toMatchObject({ type: "yesno", instructions: expect.stringMatching(/acceptance criteria/) });
    expect(pack.answer.parse(V2_ANSWER)).toEqual(V2_ANSWER);
    expect(pack.answer.safeParse({ ...V2_ANSWER, size: { choice: "XXL", confidence: 0.8 } }).success).toBe(false);
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
    expect(Object.keys(pack.questions)).toEqual(["blast_radius", "reversibility", "data_sensitivity", "complexity"]);
    for (const [name, q] of Object.entries(pack.questions)) expect(q).toMatchObject({ type: name === "complexity" ? "choice" : "score" });
    expect(Object.keys((pack.questions.blast_radius as { rubric: object }).rubric)).toEqual(["one", "some", "wide"]);
  });

  it("coverage_check asks whether scenarios pin their criteria, how much they overlap and whether a criterion is untestable", () => {
    const pack = PACKS.coverage_check;
    expect(Object.keys(pack.questions)).toEqual(["pins", "redundancy", "untestable"]);
    expect(pack.questions.pins).toMatchObject({ type: "yesno" });
    expect(pack.questions.redundancy).toMatchObject({ type: "score", rubric: { none: expect.any(String), some: expect.any(String), heavy: expect.any(String) } });
    expect(pack.questions.untestable).toMatchObject({ type: "yesno" });
  });

  it("plan_check asks only what a script cannot: whether the plan fits the record, and whether it suits its risk", () => {
    const pack = PACKS.plan_check;
    expect(Object.keys(pack.questions)).toEqual(["fits_record", "risk_appropriate"]);
    expect(pack.questions.fits_record).toMatchObject({ type: "score", rubric: { no: expect.any(String), partly: expect.any(String), yes: expect.any(String) } });
    expect(pack.questions.risk_appropriate).toMatchObject({ type: "yesno", instructions: expect.stringContaining("migration") });
    expect(Object.keys(pack.policy).sort()).toEqual(["fits_record", "risk_appropriate"]);
  });

  it("escalation_reason asks one choice among the six reasons, on the built-in engines until the host measures it", () => {
    expect(Object.keys(PACKS.escalation_reason.questions)).toEqual(["reason"]);
    const q = PACKS.escalation_reason.questions.reason!;
    expect(q.type).toBe("choice");
    expect(q.type === "choice" && Object.keys(q.criteria)).toEqual(["plan_wrong", "env_broken", "flaky_tests", "too_complex", "undeclared_scope", "other"]);
    expect(Object.keys(PACKS.escalation_reason.policy)).toEqual(["reason"]);
    expect(PACKS.escalation_reason.policy.reason).toMatchObject({ proceed: 0.7 });
    expect(PACKS.escalation_reason.engines).toEqual({ ...decisionEngines("escalation_reason"), allowed: ["jev", "claude:haiku", "codex:luna"] });
  });

  it("red_check asks whether the red is for the right reason and the test asserts the behaviour; scope_check asks six yes/no questions over the facts", () => {
    expect(Object.keys(PACKS.red_check.questions)).toEqual(["right_reason", "not_tautological"]);
    // A test written first fails because what it tests is not there: that is the behaviour missing, not a broken import.
    expect(PACKS.red_check.questions.right_reason).toMatchObject({ type: "yesno", instructions: expect.stringContaining("does not exist yet") });
    expect(Object.keys(PACKS.scope_check.questions)).toEqual(["planned_or_declared", "no_new_dependency", "no_secret_or_pii", "no_test_removed", "no_todo", "unrelated_refactors"]);
    for (const q of Object.values(PACKS.scope_check.questions)) expect(q.type).toBe("yesno");
    for (const pack of [PACKS.red_check, PACKS.scope_check]) {
      expect(pack.engines).toEqual({ ...decisionEngines(pack.id), allowed: ["jev", "claude:haiku", "codex:luna"] });
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
      expect(pack.engines).toEqual({ ...decisionEngines(pack.id), allowed: ["jev", "claude:haiku", "codex:luna"] });
      expect(Object.keys(pack.policy).sort()).toEqual(Object.keys(pack.questions).sort());
      expect(PACK_LIMITS[pack.id]).toEqual({ maxTurns: 1, timeoutMs: pack.timeoutMs, writable: false });
    }
  });

  it("evidence_format asks one format choice (video, captures, text) on the evidence context, a decision like the others", () => {
    const pack = PACKS.evidence_format;
    expect(pack.kind).toBe("decision");
    expect(Object.keys(pack.questions)).toEqual(["format"]);
    expect(pack.questions.format).toMatchObject({ type: "choice", criteria: { video: expect.stringContaining("recording"), captures: expect.any(String), text: expect.stringContaining("API") } });
    expect(pack.engines).toEqual({ ...decisionEngines(pack.id), allowed: ["jev", "claude:haiku", "codex:luna"] });
    expect(Object.keys(pack.policy)).toEqual(["format"]);
    expect(PACK_LIMITS[pack.id]).toEqual({ maxTurns: 1, timeoutMs: pack.timeoutMs, writable: false });
  });

  it("the ship decisions exist: event_class, comment_intent, fix_scope and evidence_valid each ask one choice, worth_learning one yes/no, all decisions like the others", () => {
    const packs = PACKS as Record<string, unknown>;
    const choices: Record<string, [string, string[]]> = {
      event_class: ["event", ["comment", "approval", "changes_requested", "push", "noise"]],
      comment_intent: ["intent", ["question", "nit", "change_request", "disagreement"]],
      fix_scope: ["scope", ["in_place", "re_verify_partial", "re_plan"]],
      evidence_valid: ["validity", ["valid", "refresh_text", "refresh_media"]],
    };
    for (const [id, [question, labels]] of Object.entries(choices)) {
      expect(packs, id).toHaveProperty(id);
      const pack = packs[id] as typeof PACKS.red_check;
      expect(pack.kind).toBe("decision");
      expect(Object.keys(pack.questions)).toEqual([question]);
      const q = pack.questions[question]!;
      expect(q.type).toBe("choice");
      expect(Object.keys((q as { criteria: Record<string, string> }).criteria)).toEqual(labels);
      expect(pack.engines).toEqual({ ...decisionEngines(pack.id), allowed: ["jev", "claude:haiku", "codex:luna"] });
      expect(PACK_LIMITS[pack.id]).toEqual({ maxTurns: 1, timeoutMs: pack.timeoutMs, writable: false });
    }
    expect(packs).toHaveProperty("worth_learning");
    const worth = packs.worth_learning as typeof PACKS.red_check;
    expect(Object.keys(worth.questions)).toEqual(["worth"]);
    expect(worth.questions.worth).toMatchObject({ type: "yesno" });
  });

  it("all three run on Jev by default and a small Claude or Codex model when it is absent, with a bar per question", () => {
    for (const pack of [PACKS.risk_score, PACKS.coverage_check, PACKS.plan_check]) {
      expect(pack.engines).toEqual({ ...decisionEngines(pack.id), allowed: ["jev", "claude:haiku", "codex:luna"] });
      expect(Object.keys(pack.policy).sort()).toEqual(Object.keys(pack.questions).sort());
      expect(PACK_LIMITS[pack.id]).toEqual({ maxTurns: 1, timeoutMs: pack.timeoutMs, writable: false });
    }
  });

  it("riskLevelOf multiplies the three levels (a score rounds to one, plus 1): up to 4 low, 5 to 11 medium, 12 and over high", () => {
    const at = (a: number, b: number, c: number) => riskLevelOf({ blast_radius: { score: a }, reversibility: { score: b }, data_sensitivity: { score: c } });
    expect(at(0, 0, 0)).toBe("low"); // 1
    expect(at(1, 0, 0)).toBe("low"); // 2
    expect(at(1, 1, 0)).toBe("low"); // 4
    expect(at(2, 1, 0)).toBe("medium"); // 3 x 2 x 1 = 6
    expect(at(2, 2, 0)).toBe("medium"); // 9
    expect(at(1, 1, 2)).toBe("high"); // 12
    expect(at(2, 2, 2)).toBe("high"); // 27
    expect(at(0.4, 0.4, 0.4)).toBe("low"); // rounds down
    expect(at(1.5, 1.5, 1.5)).toBe("high"); // rounds up to 3 each
  });

  it("risk_score also asks for the change's complexity: S, M, L or XL", () => {
    const question = PACKS.risk_score.questions.complexity;
    expect(question).toMatchObject({ type: "choice" });
    expect(Object.keys((question as { criteria: Record<string, string> }).criteria)).toEqual(["S", "M", "L", "XL"]);
    expect(PACKS.risk_score.policy.complexity).toBeDefined();
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
  const at = new Date("2026-11-03T12:00:00Z");
  const v1 = { kind: { choice: "question", confidence: 0.97 }, area: { choice: "machine", confidence: 0.9 }, ready: { value: false, p: 0.15 }, size: { score: 0.2, confidence: 0.8 }, urgency: { score: 1, confidence: 0.85 }, risk: { score: 0.9, confidence: 0.9 }, archive: { value: false, p: 0.05 }, archive_reason: { choice: "none", confidence: 0.95 } };

  it("still reads a stored v1 answer: the area, the one urgency score, each pick and the least sure confidence", () => {
    expect(classificationOf(v1, "typesafe-ai/jev", at)).toEqual({
      kind: "question", kindConfidence: 0.97, area: "machine", ready: false, size: 0.2, urgency: 1, risk: 0.9, archive: false, archiveReason: "none", confidence: 0.8, at: "2026-11-03T12:00:00.000Z", model: "typesafe-ai/jev",
      signals: {
        kind: { answer: "question", confidence: 0.97 }, area: { answer: "machine", confidence: 0.9 }, ready: { answer: false, confidence: 0.85 }, size: { answer: 0.2, confidence: 0.8 },
        urgency: { answer: 1, confidence: 0.85 }, risk: { answer: 0.9, confidence: 0.9 }, archive: { answer: false, confidence: 0.95 }, archive_reason: { answer: "none", confidence: 0.95 },
      },
    });
    expect(classificationOf({ ...v1, ready: { value: true, p: 0.6 } }, "m", at).confidence).toBeCloseTo(0.6, 10);
  });

  it("reads a v2 answer: type of work, size bucket, sub-scores 1 to 3, a priority from the weights, the preliminary risk", () => {
    const sure = { ...V2_ANSWER, who: { score: 2, confidence: 1 }, what: { score: 1, confidence: 1 }, impact: { score: 1, confidence: 1 }, time: { score: 0, confidence: 1 }, demand: { score: 0, confidence: 1 } };
    const c = classificationOf(sure, "claude:haiku", at);
    expect(c).toMatchObject({ kind: "bug", typeOfWork: "backend", sizeBucket: "S", riskPrelim: "low", archive: false, archiveReason: "none", ready: true });
    expect(c.subScores).toEqual({ who: 3, what: 2, impact: 2, time: 1, demand: 1 });
    // 3*3 + 3*2 + 2*2 + 2*1 + 1*1 = 22: the P1 bar
    expect(c.priority).toBe("P1");
    expect(c.area).toBeUndefined();
    expect(c.signals?.who).toEqual({ answer: 2, confidence: 1 });
    expect(c.signals?.size).toEqual({ answer: "S", confidence: 0.7 });
    expect(c.confidence).toBeCloseTo(0.7, 10);
  });

  it("pulls a doubtful sub-score toward 2 by its confidence before the weights", () => {
    const doubtful = { ...V2_ANSWER, who: { score: 2, confidence: 0.5 }, what: { score: 2, confidence: 1 }, impact: { score: 2, confidence: 1 }, time: { score: 2, confidence: 1 }, demand: { score: 2, confidence: 1 } };
    // who 3 pulled to 2.5: 3*2.5 + 3*3 + 2*3 + 2*3 + 1*3 = 31.5, P0 at 28 and P1 under a bar of 32
    expect(classificationOf(doubtful, "m", at, { bands: { P0: 32, P1: 22, P2: 16 } }).priority).toBe("P1");
    expect(classificationOf(doubtful, "m", at).priority).toBe("P0");
  });

  it("takes the repo's weights and bands", () => {
    const low = { ...V2_ANSWER, who: { score: 0, confidence: 1 }, what: { score: 0, confidence: 1 }, impact: { score: 0, confidence: 1 }, time: { score: 0, confidence: 1 }, demand: { score: 0, confidence: 1 } };
    expect(classificationOf(low, "m", at).priority).toBe("P3"); // 3+3+2+2+1 = 11
    expect(classificationOf(low, "m", at, { bands: { P0: 40, P1: 30, P2: 10 } }).priority).toBe("P2");
    expect(classificationOf(low, "m", at, { weights: { who: 10, what: 10, impact: 10, time: 10, demand: 10 }, bands: { P0: 90, P1: 60, P2: 50 } }).priority).toBe("P2"); // 50
  });

  it("makes an incident P0 whatever the scores say, and so is a security flag", () => {
    const low = { ...V2_ANSWER, who: { score: 0, confidence: 1 }, what: { score: 0, confidence: 1 }, impact: { score: 0, confidence: 1 }, time: { score: 0, confidence: 1 }, demand: { score: 0, confidence: 1 } };
    expect(classificationOf({ ...low, kind: { choice: "incident", confidence: 0.9 } }, "m", at).priority).toBe("P0");
    expect(classificationOf(low, "m", at, { flags: { security: true } }).priority).toBe("P0");
    expect(classificationOf(low, "m", at, { flags: {} }).priority).toBe("P3");
  });

  it("reads in one line: a v1 size by its rubric level, a v2 one by its bucket and priority", () => {
    const c = classificationOf(v1, "typesafe-ai/jev", new Date(0));
    expect(classificationLine(c)).toBe("question · machine · not ready · size tiny · lowest confidence 0.80 (typesafe-ai/jev) · urgency normal · risk low");
    expect(classificationLine({ ...c, ready: true, size: 2.6 })).toMatch(/· ready · size large ·/);
    expect(classificationLine({ ...c, archive: true, archiveReason: "duplicate" })).toMatch(/ · archive\? duplicate$/);
    expect(classificationLine({ kind: "bug", area: "board", ready: true, size: 1, confidence: 0.9, at: "", model: "m" })).toBe("bug · board · ready · size small · lowest confidence 0.90 (m)");
    expect(classificationLine(classificationOf(V2_ANSWER, "claude:haiku", new Date(0)))).toBe("bug · backend · ready · size S · P2 · risk low · lowest confidence 0.70 (claude:haiku)");
  });
});

describe("confidence policy", () => {
  const pack = PACKS.triage_signals;
  it("gives every question a proceed and a flag bar, flag below proceed, both in (0, 1]", () => {
    for (const [name, p] of Object.entries(pack.policy)) {
      expect(p.flag, name).toBeGreaterThan(0);
      expect(p.flag, name).toBeLessThanOrEqual(p.proceed);
      expect(p.proceed, name).toBeLessThanOrEqual(1);
    }
    expect(Object.keys(pack.policy).sort()).toEqual(Object.keys(pack.questions).sort());
  });
  it("judges each answer against its own bar and the whole answer by its worst question", () => {
    const answer = { ...V2_ANSWER, size: { choice: "S", confidence: 0.5 }, kind: { choice: "bug", confidence: 0.7 }, risk_prelim: { choice: "low", confidence: 0.5 } };
    const v = applyPolicy(pack, answer);
    expect(v.verdicts).toMatchObject({ kind: "flag", size: "flag", risk_prelim: "ask", who: "proceed", ready: "proceed", archive: "proceed" });
    expect(v.overall).toBe("ask");
    expect(v.below).toEqual(["kind", "size", "risk_prelim"]);
  });
  it("takes a repo's overrides question by question", () => {
    const answer = { ...V2_ANSWER, kind: { choice: "bug", confidence: 0.7 } };
    expect(applyPolicy(pack, answer).verdicts.kind).toBe("flag");
    const v = applyPolicy(pack, answer, { kind: { proceed: 0.6 } });
    expect(v.verdicts.kind).toBe("proceed");
  });
});

describe("the intake_dedup decision pack", () => {
  it("asks one same / related / different question per shortlist slot, with a confidence, and has no role or prompt", async () => {
    const { PACKS, DedupContext } = await import("./index.ts");
    const pack = PACKS.intake_dedup;
    expect(pack.kind).toBe("decision");
    expect(Object.keys(pack.questions)).toEqual(["slot1", "slot2", "slot3", "slot4", "slot5"]);
    const answer = Object.fromEntries(Object.keys(pack.questions).map((k) => [k, { choice: "different", confidence: 0.9 }]));
    expect(pack.answer.safeParse(answer).success).toBe(true);
    expect(pack.answer.safeParse({ ...answer, slot1: { choice: "maybe", confidence: 0.9 } }).success).toBe(false);
    expect(DedupContext.safeParse({ title: "t", text: "x", candidates: Array.from({ length: 6 }, (_, i) => ({ slot: i + 1, kind: "open", title: "a", summary: "b" })) }).success).toBe(false);
  });
});

describe("the ticket_validity decision pack", () => {
  it("asks six typed questions in one call, has no role or prompt, and names a duplicate by slot", async () => {
    const { PACKS, TicketContext } = await import("./index.ts");
    const pack = PACKS.ticket_validity;
    expect(pack.kind).toBe("decision");
    expect(Object.keys(pack.questions)).toEqual(["goal", "criteria", "scope", "duplicate", "project", "reporter"]);
    const yes = { value: true, p: 0.9 };
    const answer = { goal: yes, criteria: yes, scope: yes, duplicate: { choice: "none", confidence: 0.9 }, project: yes, reporter: yes };
    expect(pack.answer.safeParse(answer).success).toBe(true);
    expect(pack.answer.safeParse({ ...answer, duplicate: { choice: "slot6", confidence: 0.9 } }).success).toBe(false);
    expect(TicketContext.safeParse({ key: "A-1", title: "t", description: "d", type: null, priority: null, reporter: null, reachable: false, labels: [], sprint: null, dueAt: null, comments: [], linked: Array(21).fill("x"), epic: null, recent: [], files: [], candidates: [] }).success).toBe(false);
  });
});

describe("the ticket_assess decision pack", () => {
  it("asks fifteen scores and five flags in one call, reading the same ticket context as ticket_validity", async () => {
    const { PACKS } = await import("./index.ts");
    const pack = PACKS.ticket_assess;
    expect(pack.kind).toBe("decision");
    const names = Object.keys(pack.questions);
    expect(names).toHaveLength(20);
    expect(names.slice(0, 5)).toEqual(["who", "what", "impact", "time", "demand"]);
    const score = { score: 1, confidence: 0.8 };
    const flag = { value: false, p: 0.1 };
    const answer = Object.fromEntries(names.map((n) => [n, pack.questions[n]!.type === "score" ? score : flag]));
    expect(pack.answer.safeParse(answer).success).toBe(true);
    expect(pack.answer.safeParse({ ...answer, who: { score: 3, confidence: 0.8 } }).success).toBe(false);
  });
});

describe("the ticket_recommend decision pack and the ticket_reply agent pack", () => {
  it("asks one typed question of four actions, and has no role or prompt", async () => {
    const { PACKS } = await import("./index.ts");
    const pack = PACKS.ticket_recommend;
    expect(pack.kind).toBe("decision");
    expect(Object.keys(pack.questions)).toEqual(["action"]);
    expect(pack.answer.safeParse({ action: { choice: "schedule", confidence: 0.9 } }).success).toBe(true);
    expect(pack.answer.safeParse({ action: { choice: "split", confidence: 0.9 } }).success).toBe(false);
  });

  it("drafts a reply with the ticket-writer role, read-only, on a cheap engine, answering a bounded reply", async () => {
    const { PACKS, TicketReplyAnswer } = await import("./index.ts");
    const pack = PACKS.ticket_reply;
    expect(pack).toMatchObject({ kind: "agent", agent: "ticket-writer", writable: false, template: "ticket_reply.md", effort: "low" });
    expect(TicketReplyAnswer.safeParse({ reply: "x".repeat(1501), confidence: 1 }).success).toBe(false);
    expect(TicketReplyAnswer.safeParse({ reply: "Thanks, not now.", confidence: 0.8 }).success).toBe(true);
  });
});

describe("the ticket_reply pack reads hostile text and has no hands", () => {
  it("has no tools at all and one turn", async () => {
    const { PACKS, NO_ACCESS } = await import("./index.ts");
    expect(PACKS.ticket_reply).toMatchObject({ maxTurns: 1, access: NO_ACCESS });
  });
});

describe("the conversation_assess decision pack", () => {
  it("asks the kind, whether a reply is needed, three knock-outs and five scores in one call", async () => {
    const { PACKS } = await import("./index.ts");
    const pack = PACKS.conversation_assess;
    expect(pack.kind).toBe("decision");
    expect(Object.keys(pack.questions)).toEqual(["kind", "needs_reply", "production_down", "data_loss", "security", "who", "what", "impact", "time", "demand"]);
    const answer = {
      kind: { choice: "incident", confidence: 0.9 }, needs_reply: { value: true, p: 0.9 }, production_down: { value: false, p: 0.1 }, data_loss: { value: false, p: 0.1 }, security: { value: false, p: 0.1 },
      who: { score: 2, confidence: 0.8 }, what: { score: 1, confidence: 0.8 }, impact: { score: 1, confidence: 0.8 }, time: { score: 0, confidence: 0.8 }, demand: { score: 0, confidence: 0.8 },
    };
    expect(pack.answer.safeParse(answer).success).toBe(true);
    expect(pack.answer.safeParse({ ...answer, kind: { choice: "rant", confidence: 0.9 } }).success).toBe(false);
    expect(pack.answer.safeParse({ ...answer, who: { score: 3, confidence: 0.8 } }).success).toBe(false);
  });
  it("reads a conversation context: a thread of lines, the latest message, the author's profile and at most five candidates", async () => {
    const { ConversationContext } = await import("./stage.ts");
    const ok = { channel: "eng", private: false, thread: ["marta: it fails"], latest: "it fails", author: { profile: "member", title: null }, candidates: [{ slot: 1, kind: "open", title: "t", summary: "s" }] };
    expect(ConversationContext.safeParse(ok).success).toBe(true);
    expect(ConversationContext.safeParse({ ...ok, thread: Array.from({ length: 21 }, () => "a: b") }).success).toBe(false);
    expect(ConversationContext.safeParse({ ...ok, author: { profile: "stranger", title: null } }).success).toBe(false);
    expect(ConversationContext.safeParse({ ...ok, candidates: Array.from({ length: 6 }, (_, i) => ({ slot: 1, kind: "open", title: String(i), summary: "" })) }).success).toBe(false);
  });
});
