// evals/src/report.ts
// A graded case as Laminar sees it: scores on the datapoint (RFC 0003's three grades plus the
// usage), the case's input as data, the expectation as target, the answer and its grades as output.
// Pure; the runner sends it through the machine's telemetry port.
import type { EvaluationCase } from "@hardness/machine/telemetry";

import type { EvalCase } from "./cases.ts";
import type { CaseResult } from "./grade.ts";

/** Each a number or null: pass and schema are 1 or 0, checks the share passed, judge its score. */
export function evalScores(result: CaseResult): Record<string, number | null> {
  return {
    pass: result.pass ? 1 : 0,
    schema: result.schema.pass ? 1 : 0,
    checks: result.checks.length === 0 ? null : result.checks.filter((c) => c.pass).length / result.checks.length,
    judge: result.judge !== null && "score" in result.judge ? result.judge.score : null,
    turns: result.turns,
    costUsd: result.costUsd,
    // A decision pack's grades: was the label right, how sure was it, did the policy act on it.
    ...(result.decision ? { correct: result.decision.correct === null ? null : result.decision.correct ? 1 : 0, confidence: result.decision.confidence, proceed: result.decision.verdict === "proceed" ? 1 : 0 } : {}),
  };
}

export function evalDatapoint(evalCase: EvalCase, result: CaseResult, answer: unknown, index: number, traceId: string | null): EvaluationCase {
  return {
    id: evalCase.id,
    index,
    data: { pack: evalCase.pack, caseId: evalCase.id, input: evalCase.input },
    target: { outcome: evalCase.expect.outcome ?? null, checks: evalCase.expect.checks, rubric: evalCase.expect.rubric },
    output: { answer, schema: result.schema, checks: result.checks, judge: result.judge, model: result.model },
    scores: evalScores(result),
    traceId,
  };
}
