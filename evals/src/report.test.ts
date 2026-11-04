// evals/src/report.test.ts
import { describe, expect, it } from "vitest";

import type { EvalCase } from "./cases.ts";
import { Expect } from "./expect.ts";
import type { CaseResult } from "./grade.ts";
import { evalDatapoint, evalScores } from "./report.ts";

const result: CaseResult = {
  id: "incident-bot-social",
  pass: false,
  schema: { check: "answer on the slack_triage schema", pass: true, detail: null },
  checks: [
    { check: "outcome = pass", pass: true, detail: null },
    { check: "items[id=m1].priority equals P0", pass: false, detail: "found P2" },
  ],
  judge: { score: 0.4, pass: false, reasons: ["missed the outage"], costUsd: 0.02 },
  turns: 2,
  durationMs: 4000,
  costUsd: 0.01,
  model: "claude-haiku-5-5",
};

describe("evalScores", () => {
  it("scores pass, schema, the checks' share, the judge, turns and cost", () => {
    expect(evalScores(result)).toEqual({ pass: 0, schema: 1, checks: 0.5, judge: 0.4, turns: 2, costUsd: 0.01 });
  });

  it("leaves the judge and the checks null when there were none", () => {
    expect(evalScores({ ...result, checks: [], judge: null, costUsd: null })).toEqual({ pass: 0, schema: 1, checks: null, judge: null, turns: 2, costUsd: null });
    expect(evalScores({ ...result, judge: { error: "not judged" } }).judge).toBeNull();
  });
});

describe("evalDatapoint", () => {
  it("carries the case as data, the expectation as target, the answer and grades as output, and the trace", () => {
    const evalCase: EvalCase = {
      id: "incident-bot-social",
      pack: "slack_triage",
      input: { schema: 3, stage: "slack_triage", pack: "slack_triage", engine: "claude:haiku", attempt: 1, task: { id: "t", title: "Triage", description: "", criteria: [], repoPath: "", branch: "", source: null }, plan: null, decisions: [], priorFindings: [], context: { projectContext: null }, limits: { maxTurns: 3, timeoutMs: 60_000 }, env: {} } as EvalCase["input"],
      expect: Expect.parse({ schema: 1, outcome: "pass", rubric: "the outage is P0", checks: [{ kind: "equals", path: "items[id=m1].priority", value: "P0" }] }),
    };
    const datapoint = evalDatapoint(evalCase, result, { items: [] }, 3, "trace-1");
    expect(datapoint).toEqual({
      id: "incident-bot-social",
      index: 3,
      data: { pack: "slack_triage", caseId: "incident-bot-social", input: evalCase.input },
      target: { outcome: "pass", checks: evalCase.expect.checks, rubric: "the outage is P0" },
      output: { answer: { items: [] }, schema: result.schema, checks: result.checks, judge: result.judge, model: "claude-haiku-5-5" },
      scores: { pass: 0, schema: 1, checks: 0.5, judge: 0.4, turns: 2, costUsd: 0.01 },
      traceId: "trace-1",
    });
  });
});
