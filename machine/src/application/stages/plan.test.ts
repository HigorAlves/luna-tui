import type { PlanContext } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import type { TaskRow } from "../../domain/task.ts";
import type { StageContext, StageResult } from "../ports.ts";
import { COVERAGE_ROUNDS, PLAN_ROUNDS, type PlanDeps, planStage } from "./plan.ts";

const slices = [{ title: "guard j", est_loc: 12, touchpoints: ["board/src/keys.rs"], acceptance: ["no panic", "stays selected"] }];
const record = { source: "manual", kind: "bug", goal: "Stop the panic", size: "small", urgency: "high", risk: "medium", signals: {}, qa: [], decision: "plan", reason: "r", at: "2026-11-04T00:00:00.000Z", model: "m" };
const task = { id: "t1", title: "Panic", description: "d", criteria: ["no panic"], repoPath: "/repo", record } as unknown as TaskRow;
const context = (over: Partial<StageContext> = {}): StageContext => ({
  task, stage: "test_design", attempt: 1, runId: "r1", approvals: [], signal: new AbortController().signal,
  started: async () => {}, resume: { container: "c", inputCommit: null }, engine: "claude:opus", ...over,
});

const planned = (over: Record<string, unknown> = {}): StageResult => ({
  outcome: "pass",
  detail: { summary: "planned", brief: "Guard the empty list", criteria: ["no panic", "stays selected"], assumptions: ["board only"], slices, rollback: "revert the commit", ...over },
  events: [{ at: "t", kind: "stage.note", payload: { from: "plan" } }],
  usage: { turns: 3, costUsd: 0.5 },
  run: { containerId: "plan-container", transcriptPath: "/runs/r1-plan/transcript.log" },
});
const cased = (...criteria: Array<string | null>): StageResult => ({
  outcome: "pass",
  detail: { summary: "designed", cases: criteria.map((criterion, i) => ({ title: `case ${i}`, criterion, approach: "run it" })) },
  events: [{ at: "t", kind: "stage.note", payload: { from: "tests" } }],
  usage: { turns: 2, costUsd: 0.25 },
  artifacts: [{ kind: "log", path: "/a", label: "a", sha256: "x" } as never],
  run: { containerId: "tests-container", transcriptPath: "/runs/r1-tests/transcript.log" },
});

const good = {
  risk_score: { blast_radius: { score: 0, confidence: 0.9 }, reversibility: { score: 0, confidence: 0.9 }, data_sensitivity: { score: 0, confidence: 0.9 } },
  coverage_check: { pins: { value: true, p: 0.95 }, redundancy: { score: 0, confidence: 0.9 }, untestable: { value: false, p: 0.05 } },
  plan_check: { fits_record: { score: 2, confidence: 0.9 }, slices_cover_criteria: { value: true, p: 0.95 }, rollback_stated: { value: true, p: 0.95 } },
};
const bad = { ...good.plan_check, rollback_stated: { value: false, p: 0.05 } };

interface Call { pack: string; runId: string; context: StageContext; plan?: PlanContext }
const fastTask = { ...task, record: { ...record, decision: "fast_lane", risk: "low" } } as unknown as TaskRow;
const needsFull: StageResult = { outcome: "pass", detail: { summary: "a second component appears", needsFullPlan: true }, events: [{ at: "t", kind: "stage.note", payload: { from: "fast" } }] };

function setup(script: { plan?: StageResult[]; test_design?: StageResult[]; plan_fast?: StageResult[]; test_design_fast?: StageResult[]; answers?: Partial<Record<"risk_score" | "coverage_check" | "plan_check", Array<Record<string, unknown> | Error>>> } = {}, over: Partial<PlanDeps> = {}) {
  const calls: Call[] = [];
  const decided: Array<{ pack: string; plan: PlanContext; repo: string | null }> = [];
  const queues = {
    plan: [...(script.plan ?? [planned()])],
    test_design: [...(script.test_design ?? [cased("no panic", "stays selected")])],
    plan_fast: [...(script.plan_fast ?? [planned()])],
    test_design_fast: [...(script.test_design_fast ?? [cased("no panic", "stays selected")])],
  };
  const answers = Object.fromEntries((["risk_score", "coverage_check", "plan_check"] as const).map((p) => [p, [...(script.answers?.[p] ?? [])]]));
  const deps: PlanDeps = {
    runPack: async (pack, ctx, extra) => {
      calls.push({ pack, runId: ctx.runId, context: ctx, ...(extra.plan ? { plan: extra.plan } : {}) });
      const queue = queues[pack];
      return queue.length > 1 ? queue.shift()! : queue[0]!;
    },
    decide: async (pack, plan, repo) => {
      decided.push({ pack, plan, repo });
      const next = answers[pack]!.length > 1 ? answers[pack]!.shift()! : (answers[pack]![0] ?? good[pack]);
      if (next instanceof Error) throw next;
      return next;
    },
    policies: { for: async () => ({ decisions: {} }) },
    log: () => {},
    ...over,
  };
  return { run: planStage(deps), calls, decided, deps };
}

describe("planStage", () => {
  it("runs the planner, the test designer, then coverage, plan and risk decisions, and returns the plan for the one approval", async () => {
    const { run, calls, decided } = setup();
    const result = await run(context());
    expect(calls.map((c) => c.pack)).toEqual(["plan", "test_design"]);
    expect(decided.map((d) => d.pack)).toEqual(["coverage_check", "plan_check", "risk_score"]);
    expect(result.outcome).toBe("pass");
    expect(result.detail).toMatchObject({
      brief: "Guard the empty list", criteria: ["no panic", "stays selected"], assumptions: ["board only"], slices, rollback: "revert the commit",
      cases: [{ title: "case 0", criterion: "no panic" }, { title: "case 1", criterion: "stays selected" }],
      risk: { level: "medium", scores: { blast_radius: 0, reversibility: 0, data_sensitivity: 0 } },
      verdicts: { coverage: "proceed", plan: "proceed", risk: "proceed" },
      rounds: { tests: 1, plan: 1 },
      flagged: [],
      lane: "full",
    });
    expect(result.detail).not.toHaveProperty("outcome");
    expect(result.detail).not.toHaveProperty("laneNote");
  });

  it("runs each sub-run under a derived run id, not resumable and not pinned to the stage's engine", async () => {
    const { run, calls } = setup();
    await run(context());
    expect(calls.map((c) => c.runId)).toEqual(["r1-plan", "r1-tests-1"]);
    for (const call of calls) expect(call.context).toMatchObject({ stage: "test_design", started: undefined, resume: undefined, engine: undefined });
  });

  it("hands the test designer the planner's plan, and the decisions the plan with its scenarios and the record", async () => {
    const { run, calls, decided } = setup();
    await run(context());
    expect(calls[1]!.plan).toMatchObject({ record, brief: "Guard the empty list", criteria: ["no panic", "stays selected"], slices, rollback: "revert the commit", round: 1 });
    expect(calls[1]!.plan).not.toHaveProperty("gaps");
    for (const d of decided) expect(d.plan).toMatchObject({ record, brief: "Guard the empty list", slices, cases: [{ title: "case 0" }, { title: "case 1" }] });
    expect(decided[0]!.repo).toBe("/repo");
  });

  it("re-runs the test designer with the criteria no case names, until they are all covered", async () => {
    const { run, calls, decided } = setup({ test_design: [cased("no panic"), cased("no panic", "stays selected")] });
    const result = await run(context());
    expect(calls.map((c) => [c.pack, c.runId])).toEqual([["plan", "r1-plan"], ["test_design", "r1-tests-1"], ["test_design", "r1-tests-2"]]);
    expect(calls[2]!.plan).toMatchObject({ gaps: ["stays selected"], round: 2, cases: [{ criterion: "no panic" }] });
    expect(decided.filter((d) => d.pack === "coverage_check")).toHaveLength(2);
    expect(decided.find((d) => d.pack === "coverage_check")!.plan.gaps).toEqual(["stays selected"]);
    expect(result.detail).toMatchObject({ rounds: { tests: 2, plan: 1 }, flagged: [], cases: [{ criterion: "no panic" }, { criterion: "stays selected" }] });
  });

  it(`stops after ${COVERAGE_ROUNDS} designer rounds and goes on, flagging coverage`, async () => {
    const { run, calls } = setup({ test_design: [cased("no panic")] });
    const result = await run(context());
    expect(calls.filter((c) => c.pack === "test_design")).toHaveLength(COVERAGE_ROUNDS);
    expect(result.outcome).toBe("pass");
    expect(result.detail).toMatchObject({ flagged: ["coverage"], rounds: { tests: COVERAGE_ROUNDS } });
  });

  it("re-runs the planner with what the plan check found, then the designer again, up to the cap", async () => {
    const { run, calls, decided } = setup({ answers: { plan_check: [bad, good.plan_check] } });
    const result = await run(context());
    expect(calls.map((c) => [c.pack, c.runId])).toEqual([["plan", "r1-plan"], ["test_design", "r1-tests-1"], ["plan", "r1-plan-2"], ["test_design", "r1-tests-2"]]);
    expect(calls[2]!.plan).toMatchObject({ round: 2, review: [expect.stringMatching(/rollback/i)], brief: "Guard the empty list" });
    expect(decided.filter((d) => d.pack === "plan_check")).toHaveLength(2);
    expect(result.detail).toMatchObject({ rounds: { tests: 2, plan: 2 }, verdicts: { plan: "proceed" }, flagged: [] });

    const stubborn = setup({ answers: { plan_check: [bad] } });
    const capped = await stubborn.run(context());
    expect(stubborn.calls.filter((c) => c.pack === "plan")).toHaveLength(PLAN_ROUNDS + 1);
    expect(capped.detail).toMatchObject({ verdicts: { plan: "flag" }, flagged: ["plan"], rounds: { plan: PLAN_ROUNDS + 1 } });
  });

  it("scores the risk with riskLevelOf and judges each verdict by the pack's bars and the repo's overrides", async () => {
    const risky = { blast_radius: { score: 2, confidence: 0.9 }, reversibility: { score: 2, confidence: 0.4 }, data_sensitivity: { score: 1, confidence: 0.9 } };
    const { run } = setup({ answers: { risk_score: [risky] } }, { policies: { for: async () => ({ decisions: { risk_score: { reversibility: { flag: 0.3 } } } }) } });
    const result = await run(context());
    expect(result.detail).toMatchObject({ risk: { level: "high", scores: { blast_radius: 2, reversibility: 2, data_sensitivity: 1 } }, verdicts: { risk: "flag" }, flagged: ["risk"] });
  });

  it("never rates the risk below triage's grade: a decision can raise it, not lower it", async () => {
    const mild = { blast_radius: { score: 0, confidence: 0.9 }, reversibility: { score: 0, confidence: 0.9 }, data_sensitivity: { score: 0, confidence: 0.9 } };
    const { run } = setup({ answers: { risk_score: [mild] } });
    const graded = { ...task, record: { ...(task.record ?? {}), risk: "high" } as TaskRow["record"] };
    const result = await run(context({ task: graded }));
    expect(result.detail).toMatchObject({ risk: { level: "high", scores: { blast_radius: 0, reversibility: 0, data_sensitivity: 0 } } });
  });

  it("ends needs_input with the questions when the planner or the designer asks, and calls nothing after", async () => {
    const ask: StageResult = { outcome: "needs_input", needsInput: [{ question: "Which OS?", recommended: "macOS" }], detail: { questions: [{ question: "Which OS?", recommended: "macOS" }] } };
    const first = setup({ plan: [ask] });
    expect(await first.run(context())).toMatchObject({ outcome: "needs_input", needsInput: [{ question: "Which OS?" }] });
    expect(first.calls.map((c) => c.pack)).toEqual(["plan"]);
    const second = setup({ test_design: [ask] });
    expect(await second.run(context())).toMatchObject({ outcome: "needs_input" });
    expect(second.decided).toEqual([]);
  });

  it("ends the stage with a sub-run's failure or usage limit as it is, with the events so far", async () => {
    const failed: StageResult = { outcome: "fail", detail: { error: "timed out" } };
    expect(await setup({ plan: [failed] }).run(context())).toMatchObject({ outcome: "fail", detail: { error: "timed out" } });
    const limited = await setup({ test_design: [{ outcome: "fail", rateLimited: true }] }).run(context());
    expect(limited).toMatchObject({ outcome: "fail", rateLimited: true });
    expect(limited.events).toEqual([{ at: "t", kind: "stage.note", payload: { from: "plan" } }]);
  });

  it("skips a decision that cannot run (no credential, a failed call) with a log line, and the stage goes on", async () => {
    const lines: string[] = [];
    const { run } = setup({ answers: { risk_score: [new Error("no credential")] } }, { log: (l) => lines.push(l) });
    const result = await run(context());
    expect(result.outcome).toBe("pass");
    expect(result.detail).toMatchObject({ verdicts: { coverage: "proceed", plan: "proceed", risk: "skipped" }, risk: { level: "medium", scores: {} } });
    expect(lines).toEqual([expect.stringContaining("risk_score")]);
    const none = await setup({}, { decide: null }).run(context());
    expect(none.detail).toMatchObject({ verdicts: { coverage: "skipped", plan: "skipped", risk: "skipped" }, risk: { level: "medium" } });
  });

  it("merges the sub-runs' events and artifacts, sums their usage, and keeps the last run's facts", async () => {
    const { run } = setup();
    const result = await run(context());
    expect(result.events).toEqual([{ at: "t", kind: "stage.note", payload: { from: "plan" } }, { at: "t", kind: "stage.note", payload: { from: "tests" } }]);
    expect(result.artifacts).toHaveLength(1);
    expect(result.usage).toEqual({ turns: 5, costUsd: 0.75 });
    expect(result.run).toMatchObject({ containerId: "tests-container" });
  });

  it("falls back to the ticket's criteria when the planner gave none", async () => {
    const { run } = setup({ plan: [planned({ criteria: undefined })], test_design: [cased("no panic")] });
    const result = await run(context());
    expect(result.detail).toMatchObject({ criteria: ["no panic"], flagged: [] });
  });

  describe("the fast lane", () => {
    const fast = (script: Parameters<typeof setup>[0] = {}, over: Partial<PlanDeps> = {}) => setup(script, over);
    const ctx = () => context({ task: fastTask });

    it("plans and designs on the fast packs, skips coverage_check, runs plan_check once and risk_score", async () => {
      const { run, calls, decided } = fast();
      const result = await run(ctx());
      expect(calls.map((c) => [c.pack, c.runId])).toEqual([["plan_fast", "r1-plan"], ["test_design_fast", "r1-tests-1"]]);
      expect(decided.map((d) => d.pack)).toEqual(["plan_check", "risk_score"]);
      expect(result.detail).toMatchObject({ lane: "fast", verdicts: { coverage: "skipped", plan: "proceed", risk: "proceed" }, rounds: { tests: 1, plan: 1 }, flagged: [] });
      expect(result.detail).not.toHaveProperty("laneNote");
    });

    it("does not re-run anything on a finding: it flags the plan and goes on", async () => {
      const { run, calls } = fast({ answers: { plan_check: [bad] } });
      const result = await run(ctx());
      expect(calls.map((c) => c.pack)).toEqual(["plan_fast", "test_design_fast"]);
      expect(result.detail).toMatchObject({ lane: "fast", verdicts: { plan: "flag" }, flagged: ["plan"] });
    });

    it("flags coverage when a criterion has no scenario, without a second designer round", async () => {
      const { run, calls } = fast({ test_design_fast: [cased("no panic")] });
      const result = await run(ctx());
      expect(calls.filter((c) => c.pack === "test_design_fast")).toHaveLength(1);
      expect(result.detail).toMatchObject({ lane: "fast", flagged: ["coverage"] });
    });

    it("plans in full, in the same run, when the fast planner says the ticket is bigger than it looked", async () => {
      const { run, calls, decided } = fast({ plan_fast: [needsFull] });
      const result = await run(ctx());
      expect(calls.map((c) => [c.pack, c.runId])).toEqual([["plan_fast", "r1-plan"], ["plan", "r1-plan-2"], ["test_design", "r1-tests-1"]]);
      expect(decided.map((d) => d.pack)).toEqual(["coverage_check", "plan_check", "risk_score"]);
      expect(result.detail).toMatchObject({ lane: "full", laneNote: expect.stringMatching(/fast planner.*a second component appears/i), rounds: { plan: 2, tests: 1 } });
      expect(result.events).toContainEqual({ at: "t", kind: "stage.note", payload: { from: "fast" } });
    });

    it("plans in full when the plan check cannot tell whether the fast plan fits", async () => {
      const unsure = { ...good.plan_check, fits_record: { score: 2, confidence: 0.3 } };
      const { run, calls } = fast({ answers: { plan_check: [unsure, good.plan_check] } });
      const result = await run(ctx());
      expect(calls.map((c) => c.pack)).toEqual(["plan_fast", "test_design_fast", "plan", "test_design"]);
      expect(result.detail).toMatchObject({ lane: "full", laneNote: expect.stringMatching(/plan check/i), verdicts: { coverage: "proceed", plan: "proceed" } });
    });

    it("stays on the full path for a ticket triage did not send to the fast lane", async () => {
      const { run, calls } = setup();
      await run(context());
      expect(calls.map((c) => c.pack)).toEqual(["plan", "test_design"]);
    });
  });
});
