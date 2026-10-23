import { describe, expect, test } from "vitest";

import { grade, parseShortstat, passRate } from "./golden-lib.mjs";

const run = (stage, extra = {}) => ({
  stage,
  attempt: 1,
  status: "passed",
  outcome: "pass",
  costUsd: null,
  turns: null,
  ...extra,
});
const agent = (stage, costUsd = 0.4) => run(stage, { costUsd, turns: 7 });

const shipped = () => ({
  task: { state: "awaiting_ship", reason: null },
  stageRuns: [
    agent("triage"),
    agent("test_design"),
    agent("implementing", 1.2),
    run("verifying"),
    run("e2e"),
    run("delivering"),
    run("ci_watch"),
    run("evidence"),
  ],
  approvals: [{ kind: "awaiting_ship", requested: { evidence: { verdict: "pass" } } }],
});

const base = { testPassed: true, diffLines: 40, ceilingUsd: 5, expectNoRemote: true };

describe("grade", () => {
  test("a clean run that reached ship passes every check", () => {
    const g = grade({ ...base, detail: shipped() });
    expect(g.result).toBe("pass");
    expect(g.failures).toEqual([]);
    expect(g.costUsd).toBeCloseTo(2.0);
  });

  test("escalating at delivering is expected when the fixture has no remote", () => {
    const detail = shipped();
    detail.task.state = "escalated";
    detail.stageRuns = detail.stageRuns.slice(0, 5).concat(run("delivering", { status: "failed", outcome: "escalate" }));
    detail.approvals = [];
    expect(grade({ ...base, detail }).result).toBe("pass");
    expect(grade({ ...base, detail, expectNoRemote: false }).failures.join()).toMatch(/escalated/);
  });

  test("escalating before delivering is a failure", () => {
    const detail = shipped();
    detail.task.state = "escalated";
    detail.task.reason = "tests stayed red";
    detail.stageRuns = detail.stageRuns.slice(0, 3).concat(run("verifying", { status: "failed" }));
    detail.approvals = [];
    const g = grade({ ...base, detail });
    expect(g.result).toBe("fail");
    expect(g.checks.stages).toBe(false);
  });

  test("an agent stage with no usage reports is a stub", () => {
    const detail = shipped();
    detail.stageRuns[2] = run("implementing");
    const g = grade({ ...base, detail });
    expect(g.checks.stubFree).toBe(false);
    expect(g.result).toBe("fail");
  });

  test("a failing evidence verdict, a red suite, cost and size each fail the run", () => {
    const bad = shipped();
    bad.approvals[0].requested.evidence.verdict = "fail";
    expect(grade({ ...base, detail: bad }).checks.evidence).toBe(false);
    expect(grade({ ...base, detail: shipped(), testPassed: false }).checks.suite).toBe(false);
    expect(grade({ ...base, detail: shipped(), ceilingUsd: 1 }).checks.cost).toBe(false);
    expect(grade({ ...base, detail: shipped(), diffLines: 301 }).checks.size).toBe(false);
    expect(grade({ ...base, detail: shipped(), diffLines: 300 }).checks.size).toBe(true);
  });

  test("a skipped evidence verdict passes", () => {
    const detail = shipped();
    detail.approvals[0].requested.evidence.verdict = "skipped";
    expect(grade({ ...base, detail }).checks.evidence).toBe(true);
  });
});

test("parseShortstat adds insertions and deletions", () => {
  expect(parseShortstat(" 2 files changed, 10 insertions(+), 3 deletions(-)")).toBe(13);
  expect(parseShortstat(" 1 file changed, 4 deletions(-)")).toBe(4);
  expect(parseShortstat("")).toBe(0);
});

test("passRate is passed over total, 0 for none", () => {
  expect(passRate([{ result: "pass" }, { result: "fail" }, { result: "pass" }, { result: "pass" }])).toBe(0.75);
  expect(passRate([])).toBe(0);
});
