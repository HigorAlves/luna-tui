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

const cases = [
  { title: "quantity multiplies the price", criterion: "total = sum(price * qty)", approach: "npm test, a 2x item doubles the total" },
  { title: "empty cart is zero", criterion: null, approach: "direct check: total() with [] is 0" },
];
const results = (outcome = "pass") => cases.map((c) => ({ ...c, outcome }));
const finished = (stage, detail) => ({ kind: "stage.finished", payload: { stage, attempt: 1, status: "passed", outcome: "pass", detail } });

const shipped = () => ({
  task: { state: "awaiting_ship", reason: null },
  stageRuns: [
    agent("triage"),
    agent("test_design"),
    agent("implementing", 1.2),
    agent("verifying", 0.6),
    run("e2e"),
    run("delivering"),
    run("ci_watch"),
    run("evidence"),
  ],
  approvals: [
    { kind: "awaiting_test_check", requested: { summary: "s", cases } },
    { kind: "awaiting_ship", requested: { evidence: { verdict: "pass" } } },
  ],
  events: [finished("implementing", { commit: "abc" }), finished("verifying", { step: "review", verdict: "pass", results: results() })],
});

const base = { testPassed: true, diffLines: 40, ceilingUsd: 5, expectNoRemote: true, changedFiles: ["src/cart.js", "src/cart.test.js"] };

describe("grade", () => {
  test("a clean run that reached ship passes every check", () => {
    const g = grade({ ...base, detail: shipped() });
    expect(g.result).toBe("pass");
    expect(g.failures).toEqual([]);
    expect(g.costUsd).toBeCloseTo(2.6);
  });

  test("escalating at delivering is expected when the fixture has no remote", () => {
    const detail = shipped();
    detail.task.state = "escalated";
    detail.stageRuns = detail.stageRuns.slice(0, 5).concat(run("delivering", { status: "failed", outcome: "escalate" }));
    detail.approvals = detail.approvals.slice(0, 1);
    expect(grade({ ...base, detail }).result).toBe("pass");
    expect(grade({ ...base, detail, expectNoRemote: false }).failures.join()).toMatch(/escalated/);
  });

  test("escalating before delivering is a failure", () => {
    const detail = shipped();
    detail.task.state = "escalated";
    detail.task.reason = "tests stayed red";
    detail.stageRuns = detail.stageRuns.slice(0, 3).concat(run("verifying", { status: "failed" }));
    detail.approvals = detail.approvals.slice(0, 1);
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
    bad.approvals[1].requested.evidence.verdict = "fail";
    expect(grade({ ...base, detail: bad }).checks.evidence).toBe(false);
    expect(grade({ ...base, detail: shipped(), testPassed: false }).checks.suite).toBe(false);
    expect(grade({ ...base, detail: shipped(), ceilingUsd: 1 }).checks.cost).toBe(false);
    expect(grade({ ...base, detail: shipped(), diffLines: 301 }).checks.size).toBe(false);
    expect(grade({ ...base, detail: shipped(), diffLines: 300 }).checks.size).toBe(true);
  });

  test("verifying is an agent stage now: a verifying run with no usage is a stub", () => {
    const detail = shipped();
    detail.stageRuns[3] = run("verifying");
    const g = grade({ ...base, detail });
    expect(g.checks.stubFree).toBe(false);
    expect(g.failures.join()).toMatch(/stub ran: verifying/);
  });

  test("verifying must leave a test file in the diff", () => {
    const g = grade({ ...base, detail: shipped(), changedFiles: ["src/cart.js"] });
    expect(g.checks.authored).toBe(false);
    expect(g.failures).toContain("no test file in the diff: verifying authored nothing");
    for (const file of ["pkg/cart_test.go", "tests/test_cart.py", "spec/cart_spec.rb", "src/__tests__/cart.js", "a/b.spec.ts"]) {
      expect(grade({ ...base, detail: shipped(), changedFiles: ["x.go", file] }).checks.authored, file).toBe(true);
    }
  });

  test("test_design's scenarios carry an approach and verifying proves each one", () => {
    expect(grade({ ...base, detail: shipped() }).checks.scenarios).toBe(true);

    const noApproach = shipped();
    noApproach.approvals[0].requested.cases = [{ ...cases[0], approach: "" }, cases[1]];
    let g = grade({ ...base, detail: noApproach });
    expect(g.checks.scenarios).toBe(false);
    expect(g.failures).toContain("scenario without an approach: quantity multiplies the price");

    const none = shipped();
    none.approvals[0].requested.cases = [];
    expect(grade({ ...base, detail: none }).failures).toContain("test_design named no scenarios");

    const failedOne = shipped();
    failedOne.events[1].payload.detail.results = [results()[0], { ...results()[1], outcome: "fail" }];
    g = grade({ ...base, detail: failedOne });
    expect(g.checks.scenarios).toBe(false);
    expect(g.failures).toContain("scenario not proven by verifying: empty cart is zero (fail)");

    const unproven = shipped();
    unproven.events[1].payload.detail.results = [results()[0]];
    expect(grade({ ...base, detail: unproven }).failures).toContain("scenario not proven by verifying: empty cart is zero (no result)");
  });

  test("a skipped evidence verdict passes", () => {
    const detail = shipped();
    detail.approvals[1].requested.evidence.verdict = "skipped";
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
