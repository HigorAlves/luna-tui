// Grading one case, then a scorecard per pack and engine, then the diff between two scorecards.
// The order is RFC 0003's: the StageOutput and the pack's answer schema first, the case's
// deterministic checks second, the judge last. Pure: runs and verdicts come in as data.
import { type ConfidencePolicy, type EngineId, PACKS, type PackId, type StageOutput, applyPolicy, confidenceOf, lowestBar, verdictOf } from "@hardness/contracts";

import { type Calibration, type DecisionGrade, calibrate } from "./calibration.ts";
import { decisionPack, matches, type Label } from "./labels.ts";

import { type CheckResult, type Expect, runCheck } from "./expect.ts";

/** What one case's container left: a readable output, or why there is none. */
export interface CaseRun {
  id: string;
  output: StageOutput | null;
  error: string | null;
  /** Wall time around the container; the duration when the output reports none. */
  wallMs: number;
}

/** The judge's verdict on a case, or why there is none. */
export type JudgeVerdict = { score: number; pass: boolean; reasons: string[]; costUsd: number | null } | { error: string };

export interface CaseResult {
  id: string;
  pass: boolean;
  /** The StageOutput answered, and its answer is on the pack's schema. */
  schema: CheckResult;
  checks: CheckResult[];
  /** Null when the judge was skipped. */
  judge: JudgeVerdict | null;
  turns: number;
  durationMs: number;
  /** Null when the runtime reported no cost. */
  costUsd: number | null;
  model: string | null;
  /** A decision pack's three grades: right label, how sure, what the policy does with it. Absent for an agent pack or without an answer. */
  decision?: DecisionGrade;
  /** Which run of the case this is, when `--trials` ran it more than once (1 is the first). */
  trial?: number;
}

/** A decision answer's grades: `correct` against the case's label (null without one, or while a person has yet to confirm it: `review`), the mean confidence over its questions, the verdict under the pack's own bars. */
export function gradeDecision(pack: PackId, expect: Expect, answer: Record<string, unknown>): DecisionGrade | null {
  const decision = decisionPack(pack);
  if (!decision) return null;
  const confidences = Object.entries(decision.questions).map(([name, question]) => confidenceOf(question, answer[name]));
  const labelled = expect.label && expect.review !== true ? (expect.label as Label) : null;
  const questions = Object.fromEntries(
    Object.entries(decision.questions).map(([name, question], i) => [
      name,
      { correct: labelled && name in labelled ? matches(answer, { [name]: labelled[name]! }) : null, confidence: confidences[i]!, verdict: verdictOf(confidences[i]!, decision.policy[name] as ConfidencePolicy) },
    ]),
  );
  return {
    questions,
    correct: expect.label && expect.review !== true ? matches(answer, expect.label as Label) : null,
    confidence: confidences.length === 0 ? 0 : confidences.reduce((a, b) => a + b, 0) / confidences.length,
    verdict: applyPolicy(decision, answer).overall,
  };
}

/** (a) and (b): the schema, then the deterministic checks. The answer is returned for the judge. */
export function gradeAnswer(pack: PackId, expect: Expect, run: CaseRun): { answer: Record<string, unknown> | null; schema: CheckResult; checks: CheckResult[] } {
  const schemaCheck = `answer on the ${pack} schema`;
  const failed = (detail: string) => ({ answer: null, schema: { check: schemaCheck, pass: false, detail }, checks: expect.checks.map((c) => ({ ...runCheck(null, c), detail: "no answer" })) });
  const output = run.output;
  if (!output) return failed(run.error ?? "no output");
  if (!output.ok) return failed(typeof output.error === "string" ? output.error : output.error ? JSON.stringify(output.error) : output.summary || "the stage failed");
  const parsed = PACKS[pack].answer.safeParse(output.answer);
  if (!parsed.success) return failed(parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "));
  const answer = output.answer as Record<string, unknown>;
  const checks = expect.checks.map((check) => runCheck(answer, check));
  if (expect.outcome) {
    const pass = output.outcome === expect.outcome;
    checks.unshift({ check: `outcome = ${expect.outcome}`, pass, detail: pass ? null : `found ${output.outcome}` });
  }
  return { answer, schema: { check: schemaCheck, pass: true, detail: null }, checks };
}

/** The case's result: it passes when the schema, every check and (unless skipped) the judge pass. */
export function caseResult(pack: PackId, expect: Expect, run: CaseRun, judge: JudgeVerdict | null): CaseResult {
  const { answer, schema, checks } = gradeAnswer(pack, expect, run);
  const decision = answer ? gradeDecision(pack, expect, answer) : null;
  const judged = judge === null || ("pass" in judge && judge.pass);
  const usage = run.output?.usage;
  return {
    id: run.id,
    pass: schema.pass && checks.every((c) => c.pass) && judged,
    schema,
    checks,
    judge,
    turns: usage?.turns ?? 0,
    durationMs: usage?.durationMs || run.wallMs,
    costUsd: usage?.costUsd ?? null,
    model: usage?.model || null,
    ...(decision ? { decision } : {}),
  };
}

export interface Summary {
  cases: number;
  passed: number;
  passRate: number;
  /** Over the cases the judge scored; null when it scored none. */
  meanJudgeScore: number | null;
  meanTurns: number;
  meanDurationMs: number;
  /** The engine under test's cost, summed; null when no case reported one. */
  costUsd: number | null;
  judgeCostUsd: number | null;
  /** A decision pack's calibration over its graded cases; absent for an agent pack. */
  calibration?: Calibration;
  /** A pack read answer by answer: the calibration of each question over the cases, and of the pool of every (case, question) pair. Absent for a baseline from before, and for a pack read as a whole. */
  perQuestion?: Record<string, Calibration>;
  answers?: Calibration;
}

export interface Scorecard {
  schema: 1;
  pack: PackId;
  engine: EngineId;
  /** The model the runs reported, else null. */
  model: string | null;
  /** The judge's engine, or null when it was skipped. */
  judge: EngineId | null;
  at: string;
  /** Runs of each case, when more than one. */
  trials?: number;
  summary: Summary;
  cases: CaseResult[];
}

const mean = (values: number[]): number => (values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length);
const sumOrNull = (values: (number | null)[]): number | null => {
  const known = values.filter((v): v is number => v !== null);
  return known.length === 0 ? null : known.reduce((a, b) => a + b, 0);
};
const scored = (judge: JudgeVerdict | null): judge is Extract<JudgeVerdict, { score: number }> => judge !== null && "score" in judge;

/** Every (case, question) pair graded on its own: each question's calibration, and the pool of them all. */
function perAnswer(decision: NonNullable<ReturnType<typeof decisionPack>>, grades: DecisionGrade[]): Pick<Summary, "perQuestion" | "answers"> {
  const pairs = Object.keys(decision.questions).map((name) => [name, grades.flatMap((g) => (g.questions?.[name] ? [g.questions[name]!] : []))] as const);
  return {
    perQuestion: Object.fromEntries(pairs.map(([name, list]) => [name, calibrate(list, { bar: (decision.policy[name] as ConfidencePolicy).proceed })])),
    answers: calibrate(pairs.flatMap(([, list]) => list), { bar: lowestBar(decision.policy) }),
  };
}

export function summarize(cases: CaseResult[], pack?: PackId): Summary {
  const grades = cases.flatMap((c) => (c.decision ? [c.decision] : []));
  const decision = pack ? decisionPack(pack) : null;
  const passed = cases.filter((c) => c.pass).length;
  const scores = cases.map((c) => c.judge).filter(scored);
  return {
    cases: cases.length,
    passed,
    passRate: cases.length === 0 ? 0 : passed / cases.length,
    meanJudgeScore: scores.length === 0 ? null : mean(scores.map((j) => j.score)),
    meanTurns: mean(cases.map((c) => c.turns)),
    meanDurationMs: mean(cases.map((c) => c.durationMs)),
    costUsd: sumOrNull(cases.map((c) => c.costUsd)),
    judgeCostUsd: sumOrNull(scores.map((j) => j.costUsd)),
    ...(decision ? { calibration: calibrate(grades, { bar: lowestBar(decision.policy) }) } : {}),
    ...(decision?.measure === "answer" ? perAnswer(decision, grades) : {}),
  };
}

export function scorecard(meta: { pack: PackId; engine: EngineId; judge: EngineId | null; at: string; trials?: number }, cases: CaseResult[]): Scorecard {
  return { schema: 1, ...meta, model: cases.find((c) => c.model)?.model ?? null, summary: summarize(cases, meta.pack), cases };
}

export interface ScorecardDiff {
  base: { engine: EngineId; at: string };
  next: { engine: EngineId; at: string };
  /** How many cases both ran; every delta below is over these alone. */
  common: number;
  /** next minus base. */
  passRate: number;
  meanJudgeScore: number | null;
  meanTurns: number;
  meanDurationMs: number;
  costUsd: number | null;
  /** next minus base for a decision pack's metrics, over the common cases; each null when either side has none. */
  calibration?: Partial<Record<"accuracy" | "actedOnAccuracy" | "coverage" | "brier" | "ece", number | null>>;
  /** Cases that passed on one side and failed on the other. */
  flips: { id: string; base: boolean; next: boolean }[];
  onlyBase: string[];
  onlyNext: string[];
}

const delta = (a: number | null, b: number | null): number | null => (a === null || b === null ? null : b - a);

/** `next` against `base`, over the cases both ran: a subset run compares like for like. */
export function diffScorecards(base: Scorecard, next: Scorecard): ScorecardDiff {
  // A case run in several trials is several entries: the first keeps its id, the others carry `#<trial>`.
  const key = (c: CaseResult) => ((c.trial ?? 1) > 1 ? `${c.id}#${c.trial}` : c.id);
  const baseIds = new Map(base.cases.map((c) => [key(c), c]));
  const nextIds = new Map(next.cases.map((c) => [key(c), c]));
  const common = [...nextIds.keys()].filter((id) => baseIds.has(id));
  const a = summarize(common.map((id) => baseIds.get(id)!), base.pack);
  const b = summarize(common.map((id) => nextIds.get(id)!), next.pack);
  const calibration = a.calibration && b.calibration ? Object.fromEntries((["accuracy", "actedOnAccuracy", "coverage", "brier", "ece"] as const).map((m) => [m, delta(a.calibration![m], b.calibration![m])])) : undefined;
  return {
    base: { engine: base.engine, at: base.at },
    next: { engine: next.engine, at: next.at },
    common: common.length,
    passRate: b.passRate - a.passRate,
    meanJudgeScore: delta(a.meanJudgeScore, b.meanJudgeScore),
    meanTurns: b.meanTurns - a.meanTurns,
    meanDurationMs: b.meanDurationMs - a.meanDurationMs,
    costUsd: delta(a.costUsd, b.costUsd),
    ...(calibration ? { calibration } : {}),
    flips: common.filter((id) => baseIds.get(id)!.pass !== nextIds.get(id)!.pass).map((id) => ({ id, base: baseIds.get(id)!.pass, next: nextIds.get(id)!.pass })),
    onlyBase: [...baseIds.keys()].filter((id) => !nextIds.has(id)),
    onlyNext: [...nextIds.keys()].filter((id) => !baseIds.has(id)),
  };
}
