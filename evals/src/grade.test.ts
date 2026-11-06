import type { StageOutput } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import { Expect } from "./expect.ts";
import { formatDiff, formatScorecard } from "./format.ts";
import { type CaseResult, type CaseRun, caseResult, diffScorecards, gradeAnswer, gradeDecision, scorecard, summarize } from "./grade.ts";

const verdict = (id: string, priority: string) => ({ id, priority, category: "question", expectsReply: true, summary: "s", why: "w", draft: "d", refs: [], deadline: null });

const output = (answer: unknown, over: Partial<StageOutput> = {}): StageOutput => ({
  schema: 3,
  ok: true,
  outcome: "pass",
  summary: "",
  answer: answer as Record<string, unknown>,
  needsInput: null,
  requested: [],
  findings: [],
  artifacts: [],
  slices: { done: 0, total: 0 },
  commit: null,
  usage: { turns: 2, costUsd: 0.01, durationMs: 4000, model: "claude-haiku-5-5" },
  error: null,
  rateLimited: false,
  resetsAt: null,
  ...over,
});
const run = (id: string, out: StageOutput | null, error: string | null = null): CaseRun => ({ id, output: out, error, wallMs: 9000 });

const expectation = Expect.parse({
  schema: 1,
  outcome: "pass",
  rubric: "the outage is P0",
  checks: [
    { kind: "equals", path: "items[id=m1].priority", value: "P0" },
    { kind: "count", path: "items", min: 1, max: 1 },
  ],
});

describe("gradeAnswer", () => {
  it("passes an answer on the pack's schema that meets every check and the outcome", () => {
    const graded = gradeAnswer("slack_triage", expectation, run("c1", output({ items: [verdict("m1", "P0")] })));
    expect(graded.schema).toEqual({ check: "answer on the slack_triage schema", pass: true, detail: null });
    expect(graded.checks.map((c) => [c.check, c.pass])).toEqual([["outcome = pass", true], ['items[id=m1].priority = "P0"', true], ["items count 1..1", true]]);
    expect(graded.answer).toEqual({ items: [verdict("m1", "P0")] });
  });

  it("fails the schema, and every check with it, on no output, a failed run or an off-schema answer", () => {
    const none = gradeAnswer("slack_triage", expectation, run("c1", null, "timed out after 3 minutes"));
    expect(none.schema).toMatchObject({ pass: false, detail: "timed out after 3 minutes" });
    expect(none.checks.every((c) => !c.pass && c.detail === "no answer")).toBe(true);
    expect(gradeAnswer("slack_triage", expectation, run("c1", output(null, { ok: false, error: "rate limited" }))).schema.detail).toBe("rate limited");
    const off = gradeAnswer("slack_triage", expectation, run("c1", output({ items: [{ ...verdict("m1", "P9") }] })));
    expect(off.schema).toMatchObject({ pass: false, detail: expect.stringContaining("items.0.priority") });
  });

  it("checks the outcome the case expects", () => {
    const asked = Expect.parse({ schema: 1, outcome: "needs_input", rubric: "r" });
    const graded = gradeAnswer("slack_triage", asked, run("c1", output({ items: [] })));
    expect(graded.checks).toEqual([{ check: "outcome = needs_input", pass: false, detail: "found pass" }]);
  });
});

describe("caseResult", () => {
  it("needs the judge's pass too, unless the judge was skipped; usage comes from the output", () => {
    const good = run("c1", output({ items: [verdict("m1", "P0")] }));
    expect(caseResult("slack_triage", expectation, good, null)).toMatchObject({ pass: true, judge: null, turns: 2, durationMs: 4000, costUsd: 0.01, model: "claude-haiku-5-5" });
    expect(caseResult("slack_triage", expectation, good, { score: 0.9, pass: true, reasons: [], costUsd: 0.2 }).pass).toBe(true);
    expect(caseResult("slack_triage", expectation, good, { score: 0.4, pass: false, reasons: ["vague"], costUsd: 0.2 }).pass).toBe(false);
    expect(caseResult("slack_triage", expectation, good, { error: "judge timed out" }).pass).toBe(false);
  });

  it("falls back to the wall time, and to no cost, when the runtime reports none", () => {
    const bare = run("c1", output({ items: [verdict("m1", "P0")] }, { usage: { turns: 1, costUsd: null, durationMs: 0, model: "" } }));
    expect(caseResult("slack_triage", expectation, bare, null)).toMatchObject({ durationMs: 9000, costUsd: null, model: null });
    expect(caseResult("slack_triage", expectation, run("c2", null, "no result"), null)).toMatchObject({ pass: false, turns: 0, durationMs: 9000, costUsd: null });
  });
});

const result = (id: string, pass: boolean, over: Partial<CaseResult> = {}): CaseResult => ({
  id,
  pass,
  schema: { check: "schema", pass: true, detail: null },
  checks: [],
  judge: null,
  turns: 2,
  durationMs: 1000,
  costUsd: null,
  model: "m",
  ...over,
});

describe("summarize", () => {
  it("pass rate, mean judge score over the scored cases, mean turns and duration, summed costs", () => {
    const cases = [
      result("a", true, { judge: { score: 1, pass: true, reasons: [], costUsd: 0.1 }, costUsd: 0.02, turns: 1, durationMs: 1000 }),
      result("b", false, { judge: { error: "x" }, costUsd: null, turns: 3, durationMs: 3000 }),
      result("c", true, { judge: { score: 0.5, pass: false, reasons: [], costUsd: null }, costUsd: 0.04, turns: 2, durationMs: 2000 }),
      result("d", false),
    ];
    const s = summarize(cases);
    expect(s).toMatchObject({ cases: 4, passed: 2, passRate: 0.5, meanJudgeScore: 0.75, meanTurns: 2, meanDurationMs: 1750 });
    expect(s.costUsd).toBeCloseTo(0.06);
    expect(s.judgeCostUsd).toBeCloseTo(0.1);
    expect(summarize([result("a", true)])).toMatchObject({ meanJudgeScore: null, costUsd: null, judgeCostUsd: null });
    expect(summarize([])).toMatchObject({ cases: 0, passRate: 0, meanTurns: 0 });
  });
});

describe("diffScorecards", () => {
  const meta = (engine: "claude:haiku" | "codex:luna", at: string) => ({ pack: "slack_triage" as const, engine, judge: "claude:opus" as const, at });

  it("compares the cases both ran, lists the flips and the cases on one side only", () => {
    const base = scorecard(meta("claude:haiku", "t0"), [
      result("a", true, { judge: { score: 0.9, pass: true, reasons: [], costUsd: null }, costUsd: 0.01, turns: 1 }),
      result("b", true, { judge: { score: 0.8, pass: true, reasons: [], costUsd: null }, costUsd: 0.01, turns: 1 }),
      result("gone", false),
    ]);
    const next = scorecard(meta("codex:luna", "t1"), [
      result("a", true, { judge: { score: 0.7, pass: true, reasons: [], costUsd: null }, costUsd: 0.03, turns: 2 }),
      result("b", false, { judge: { score: 0.3, pass: false, reasons: [], costUsd: null }, costUsd: 0.01, turns: 2 }),
      result("new", true),
    ]);
    expect(next.model).toBe("m");
    const diff = diffScorecards(base, next);
    expect(diff).toMatchObject({ base: { engine: "claude:haiku" }, next: { engine: "codex:luna" }, common: 2, passRate: -0.5, meanTurns: 1, meanDurationMs: 0, flips: [{ id: "b", base: true, next: false }], onlyBase: ["gone"], onlyNext: ["new"] });
    expect(diff.meanJudgeScore).toBeCloseTo(-0.35);
    expect(diff.costUsd).toBeCloseTo(0.02);
    expect(diffScorecards(scorecard(meta("claude:haiku", "t0"), [result("a", true)]), next).costUsd).toBeNull();
  });

  it("prints the scorecard and the diff", () => {
    const card = scorecard(meta("codex:luna", "t1"), [
      result("a", true, { costUsd: 0.03, judge: { score: 0.8, pass: true, reasons: [], costUsd: 0.1 } }),
      result("b", false, { checks: [{ check: "items count 1..1", pass: false, detail: "found 2" }], judge: { score: 0.3, pass: false, reasons: ["m2 is no P0"], costUsd: 0.1 } }),
    ]);
    const text = formatScorecard(card);
    expect(text).toContain("slack_triage on codex:luna (m) · judge claude:opus");
    expect(text).toMatch(/PASS {2}a +checks 1\/1 {2}judge 0\.80 {2}2 turn\(s\) {2}1\.0s {2}\$0\.0300/);
    expect(text).toContain("x items count 1..1: found 2");
    expect(text).toContain("judge: m2 is no P0");
    expect(text).toContain("pass 1/2 (50%) · judge 0.55 · 2.0 turns · 1.0s mean · $0.0300 (judge $0.2000)");
    const diff = diffScorecards(scorecard(meta("claude:haiku", "t0"), [result("a", true, { costUsd: 0.01 }), result("b", true, { costUsd: 0.01 })]), card);
    expect(formatDiff(diff)).toBe("codex:luna vs claude:haiku over 2 case(s): pass rate -50 pts · judge n/a · turns +0.0 · duration +0.0s · cost +$0.0100\n  flipped: b (pass -> fail)");
  });
});

describe("a decision pack's grades", () => {
  const worth = (value: boolean, p: number) => run("c1", output({ worth: { value, p } }));
  const labelled = Expect.parse({ schema: 1, rubric: "r", label: { worth: { value: true } }, checks: [{ kind: "equals", path: "worth.value", value: true }] });
  const unlabelled = Expect.parse({ schema: 1, rubric: "r", review: true });

  it("grades correct, confidence and the verdict under the pack's own bars (a yes/no's confidence is its distance from a coin toss)", () => {
    expect(caseResult("worth_learning", labelled, worth(true, 0.9), null).decision).toMatchObject({ correct: true, confidence: 0.9, verdict: "proceed" });
    // p 0.1 says no with 0.9 confidence: wrong against a yes label, still proceed.
    expect(caseResult("worth_learning", labelled, worth(false, 0.1), null).decision).toMatchObject({ correct: false, confidence: 0.9, verdict: "proceed" });
    expect(caseResult("worth_learning", labelled, worth(true, 0.6), null).decision).toMatchObject({ correct: true, verdict: "flag" });
  });

  it("leaves correct null for a labelled case still marked for review: an outcome's label counts once a person confirms it", () => {
    const outcome = Expect.parse({ schema: 1, rubric: "r", label: { worth: { value: true } }, review: true, checks: [] });
    expect(caseResult("worth_learning", outcome, worth(true, 0.9), null).decision).toMatchObject({ correct: null });
  });

  it("leaves correct null for a case with no label, and grades nothing for an agent pack or a missing answer", () => {
    expect(caseResult("worth_learning", unlabelled, worth(true, 0.9), null).decision).toMatchObject({ correct: null });
    expect(caseResult("slack_triage", expectation, run("c1", output({ items: [verdict("m1", "P0")] })), null).decision).toBeUndefined();
    expect(caseResult("worth_learning", labelled, run("c2", null, "no result"), null).decision).toBeUndefined();
  });

  it("summarizes calibration for a decision pack and diffs it over the cases both ran", () => {
    const grade = (correct: boolean | null, confidence: number, verdict: "proceed" | "flag" | "ask") => ({ decision: { correct, confidence, verdict } });
    const base = scorecard({ pack: "worth_learning", engine: "claude:haiku", judge: null, at: "t0" }, [result("a", true, grade(true, 0.9, "proceed")), result("b", false, grade(false, 0.8, "proceed"))]);
    const next = scorecard({ pack: "worth_learning", engine: "codex:luna", judge: null, at: "t1", trials: 2 }, [result("a", true, grade(true, 0.9, "proceed")), result("b", true, grade(true, 0.9, "proceed")), result("b", true, { ...grade(true, 0.9, "proceed"), trial: 2 })]);
    expect(base.summary.calibration).toMatchObject({ n: 2, labelled: 2, accuracy: 0.5, actedOnAccuracy: 0.5, coverage: 1, overconfident: 1 });
    expect(next.summary.calibration).toMatchObject({ n: 3, accuracy: 1 });
    const diff = diffScorecards(base, next);
    expect(diff.common).toBe(2);
    expect(diff.calibration).toMatchObject({ accuracy: 0.5, actedOnAccuracy: 0.5, coverage: 0 });
    expect(diff.onlyNext).toEqual(["b#2"]);
    expect(summarize([result("a", true)]).calibration).toBeUndefined();
  });

  it("prints the calibration line and each case's label grade", () => {
    const card = scorecard({ pack: "worth_learning", engine: "claude:haiku", judge: null, at: "t", trials: 3 }, [result("a", true, { decision: { correct: true, confidence: 0.9, verdict: "proceed" } }), result("b", false, { decision: { correct: false, confidence: 0.4, verdict: "ask" }, trial: 2 })]);
    // Brier (0.1^2 + 0.4^2)/2 = 0.085; ECE: bin [0.8,1] gap 0.1 x 1/2 + bin [0.4,0.6) gap 0.4 x 1/2 = 0.25.
    const text = formatScorecard(card);
    expect(text).toContain("label right · conf 0.90 proceed");
    expect(text).toMatch(/b#2 .*label wrong · conf 0\.40 ask/);
    expect(text).toContain("accuracy 50% (2 labelled of 2) · acted-on 100% · coverage 50% · Brier 0.085 · ECE 0.250 · mean confidence 0.65 · overconfident 0 · 3 trials");
  });
});

describe("per-question grades", () => {
  it("grades each question against the case's label for it: right or wrong, its own confidence, its own bar; null where the label is silent", () => {
    const answer = { blast_radius: { score: 1, confidence: 0.9 }, reversibility: { score: 0, confidence: 0.4 }, data_sensitivity: { score: 0, confidence: 0.9 }, complexity: { choice: "M", confidence: 0.9 } };
    const expectation = { schema: 1, checks: [], label: { blast_radius: { score: 1 }, reversibility: { score: 2 } } } as never;
    const grade = gradeDecision("risk_score", expectation, answer)!;
    expect(grade.questions).toEqual({
      blast_radius: { correct: true, confidence: 0.9, verdict: "proceed" },
      reversibility: { correct: false, confidence: 0.4, verdict: "ask" },
      data_sensitivity: { correct: null, confidence: 0.9, verdict: "proceed" },
      complexity: { correct: null, confidence: 0.9, verdict: "proceed" },
    });
  });
});
