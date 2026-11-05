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

/** v2 scenarios by criterion id: `S1`... in order, each `[ref, type]` (type happy when left out). */
const scenes = (...rows: Array<[string] | [string, string]>): StageResult => ({
  outcome: "pass",
  detail: { summary: "designed", cases: rows.map(([ref, type], i) => ({ id: `S${i + 1}`, title: `s${i + 1}`, criterion: null, criterion_ref: ref, type: type ?? "happy", approach: "a" })) },
  events: [{ at: "t", kind: "stage.note", payload: { from: "tests" } }],
});
const notPinned = { pins: { value: false, p: 0.05 }, redundancy: { score: 0, confidence: 0.9 }, untestable: { value: false, p: 0.05 } };

const good = {
  risk_score: { blast_radius: { score: 0, confidence: 0.9 }, reversibility: { score: 0, confidence: 0.9 }, data_sensitivity: { score: 0, confidence: 0.9 }, complexity: { choice: "S", confidence: 0.9 } },
  coverage_check: { pins: { value: true, p: 0.95 }, redundancy: { score: 0, confidence: 0.9 }, untestable: { value: false, p: 0.05 } },
  plan_check: { fits_record: { score: 2, confidence: 0.9 }, slices_cover_criteria: { value: true, p: 0.95 }, rollback_stated: { value: true, p: 0.95 }, touchpoints_in_map: { value: true, p: 0.95 } },
};
const bad = { ...good.plan_check, rollback_stated: { value: false, p: 0.05 } };
const mapped = (over: Record<string, unknown> = {}): StageResult => ({
  outcome: "pass",
  detail: { summary: "mapped", map: { components: ["board keys"], files: ["board/src/keys.rs"], owners: ["@marta"], confidence: 0.8 }, ...over },
  events: [{ at: "t", kind: "stage.note", payload: { from: "map" } }],
  usage: { turns: 1, costUsd: 0.01 },
});
// What the stage hands on after parsing: a plain-string file reads as a file to change.
const theMap = { components: ["board keys"], files: [{ path: "board/src/keys.rs", role: "change" }], entry_points: [], owners: ["@marta"], confidence: 0.8 };
const withGraph = { graph: { stampOf: async () => ({ commit: "c" }) } };
const located = (over: Record<string, unknown> = {}) => ({ files: ["board/src/keys.rs"], symbols: ["handleKey"], components: ["board keys"], confidence: 0.6, owners: [{ path: "board/src/keys.rs", owners: ["@marta"] }], codeowners: true, stale: false, behind: 3, ...over });
const locating = (over: Record<string, unknown> | null = {}) => ({ graph: { stampOf: async () => ({ commit: "c" }), locate: async () => (over === null ? null : located(over)) } });

interface Call { pack: string; runId: string; context: StageContext; plan?: PlanContext }
const fastTask = { ...task, record: { ...record, decision: "fast_lane", risk: "low" } } as unknown as TaskRow;
const needsFull: StageResult = { outcome: "pass", detail: { summary: "a second component appears", needsFullPlan: true }, events: [{ at: "t", kind: "stage.note", payload: { from: "fast" } }] };

function setup(script: { plan?: StageResult[]; test_design?: StageResult[]; plan_fast?: StageResult[]; test_design_fast?: StageResult[]; code_map?: StageResult[]; answers?: Partial<Record<"risk_score" | "coverage_check" | "plan_check", Array<Record<string, unknown> | Error>>> } = {}, over: Partial<PlanDeps> = {}) {
  const calls: Call[] = [];
  const decided: Array<{ pack: string; plan: PlanContext; repo: string | null }> = [];
  const queues = {
    plan: [...(script.plan ?? [planned()])],
    test_design: [...(script.test_design ?? [cased("no panic", "stays selected")])],
    plan_fast: [...(script.plan_fast ?? [planned()])],
    test_design_fast: [...(script.test_design_fast ?? [cased("no panic", "stays selected")])],
    code_map: [...(script.code_map ?? [mapped()])],
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
    policies: { for: async () => ({ decisions: {}, graph: true }) },
    log: () => {},
    ...over,
  };
  return { run: planStage(deps), calls, decided, deps };
}

describe("planStage's code map", () => {
  it("runs code_map first, under <runId>-map, when the repo has a graph, and hands the map to the planner and every decision", async () => {
    const { run, calls, decided } = setup({}, withGraph);
    const result = await run(context());
    expect(calls.map((c) => [c.pack, c.runId])).toEqual([["code_map", "r1-map"], ["plan", "r1-plan"], ["test_design", "r1-tests-1"]]);
    expect(calls[1]!.plan).toMatchObject({ record, map: theMap });
    for (const d of decided.filter((k) => k.pack !== "coverage_check")) expect(d.plan).toMatchObject({ map: theMap });
    expect(result.detail).toMatchObject({ map: theMap });
    expect(result.events).toContainEqual({ at: "t", kind: "stage.note", payload: { from: "map" } });
    expect(result.usage?.turns).toBe(6);
  });

  it("seeds the mapper with the graph's shortlist (files, symbols, components, owners) and says nothing is stale when the graph is current", async () => {
    const { run, calls } = setup({}, locating());
    const result = await run(context());
    expect(calls[0]).toMatchObject({ pack: "code_map", plan: { record, shortlist: { files: ["board/src/keys.rs"], symbols: ["handleKey"], components: ["board keys"], owners: ["@marta"] } } });
    expect(result.detail).toMatchObject({ map: { ...theMap, stale: false, behind: 3 }, flagged: [] });
    expect(result.detail).not.toHaveProperty("mapNote");
  });

  it("looks the goal up in the graph with the ticket's title and description and the repo's stale bar", async () => {
    const seen: Array<{ text: string; options?: { staleCommits?: number } }> = [];
    const graph = { stampOf: async () => ({ commit: "c" }), locate: async (_repo: string, text: string, options?: { staleCommits?: number }) => { seen.push({ text, options }); return located(); } };
    const repo = { policies: { for: async () => ({ decisions: {}, graph: true, factory: { plan: { coverage_rounds: 3, plan_check_retries: 2 }, graph: { stale_commits: 7 } } }) } };
    await setup({}, { graph, ...repo }).run(context());
    expect(seen).toEqual([{ text: "Panic\nd", options: { staleCommits: 7 } }]);
  });

  it("flags a stale map on the gate with how far behind the graph is", async () => {
    const { run } = setup({}, locating({ stale: true, behind: 120 }));
    const result = await run(context());
    expect(result.detail).toMatchObject({ map: { stale: true, behind: 120 }, flagged: ["map stale"] });
  });

  it("goes on with an unseeded mapper and an unmarked map when the graph cannot locate", async () => {
    const { run, calls } = setup({}, locating(null));
    const result = await run(context());
    expect(calls[0]!.plan?.shortlist).toBeUndefined();
    expect(result.detail?.map).toEqual(theMap);
    const throwing = { graph: { stampOf: async () => ({ commit: "c" }), locate: async () => { throw new Error("graph unreadable"); } } };
    expect((await setup({}, throwing).run(context())).detail?.map).toEqual(theMap);
  });

  it("says on the gate that there is no map when the repo has no graph, or the mapper gave none", async () => {
    const none = await setup().run(context());
    expect(none.detail).toMatchObject({ map: null, mapNote: expect.stringMatching(/no code graph/i) });
    const failed = await setup({ code_map: [{ outcome: "fail", detail: { error: "timed out" } }] }, withGraph).run(context());
    expect(failed.detail).toMatchObject({ map: null, mapNote: expect.stringMatching(/code map could not be made/i) });
  });

  it("does not call code_map without a graph, or with the repo's graph off, and the detail says map null", async () => {
    for (const over of [{}, { graph: { stampOf: async () => null } }, { ...withGraph, policies: { for: async () => ({ decisions: {}, graph: false }) } }]) {
      const { run, calls, decided } = setup({}, over);
      const result = await run(context());
      expect(calls.map((c) => c.pack)).toEqual(["plan", "test_design"]);
      expect(calls[0]!.plan?.map ?? null).toBeNull();
      for (const d of decided) expect(d.plan.map ?? null).toBeNull();
      expect(result.detail).toMatchObject({ map: null });
    }
  });

  it("goes on without a map when code_map fails, and says why in the log", async () => {
    const lines: string[] = [];
    const { run, calls } = setup({ code_map: [{ outcome: "fail", detail: { error: "timed out" } }] }, { ...withGraph, log: (l) => lines.push(l) });
    const result = await run(context());
    expect(calls.map((c) => c.pack)).toEqual(["code_map", "plan", "test_design"]);
    expect(result.outcome).toBe("pass");
    expect(result.detail).toMatchObject({ map: null });
    expect(lines).toEqual([expect.stringContaining("code_map")]);
  });

  it("keeps the map on the planner's re-runs", async () => {
    const { run, calls } = setup({ answers: { plan_check: [bad, good.plan_check] } }, withGraph);
    await run(context());
    const replans = calls.filter((c) => c.pack === "plan");
    expect(replans).toHaveLength(2);
    expect(replans[1]!.plan).toMatchObject({ map: theMap, round: 2 });
  });

  it("makes a slice outside the map a plan_check finding only when a map exists", async () => {
    const outside = { ...good.plan_check, touchpoints_in_map: { value: false, p: 0.05 } };
    const withMap = setup({ answers: { plan_check: [outside] } }, withGraph);
    const flagged = await withMap.run(context());
    expect(withMap.calls.filter((c) => c.pack === "plan").length).toBeGreaterThan(1);
    expect(withMap.calls.filter((c) => c.pack === "plan")[1]!.plan).toMatchObject({ review: ["a slice touches files outside the code map"] });
    expect(flagged.detail).toMatchObject({ verdicts: { plan: "flag" } });
    const noMap = setup({ answers: { plan_check: [outside] } });
    const clean = await noMap.run(context());
    expect(noMap.calls.filter((c) => c.pack === "plan")).toHaveLength(1);
    expect(clean.detail).toMatchObject({ verdicts: { plan: "proceed" }, flagged: [] });
  });
});

describe("planStage", () => {
  it("runs the planner, the test designer, then coverage, plan and risk decisions, and returns the plan for the one approval", async () => {
    const { run, calls, decided } = setup();
    const result = await run(context());
    expect(calls.map((c) => c.pack)).toEqual(["plan", "test_design"]);
    expect(decided.map((d) => d.pack)).toEqual(["risk_score", "coverage_check", "plan_check"]);
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

  it("stores the v2.2 Plan on the gate beside today's keys: ids by position, out of scope, migration, flags, a version", async () => {
    const steps = [{ title: "guard j", description: "guard j", est_loc: 12, files: ["board/src/keys.rs", "board/src/keys_new.rs"], new_files: ["board/src/keys_new.rs"], done_when: ["no panic", "stays selected"], touchpoints: ["board/src/keys.rs", "board/src/keys_new.rs"], acceptance: ["no panic", "stays selected"] }];
    const { run } = setup({ plan: [planned({ steps, outOfScope: ["the help text"], migration: "none", flags: ["guard_j"], slices: [{ title: "guard j", est_loc: 12, touchpoints: ["board/src/keys.rs", "board/src/keys_new.rs"], acceptance: ["no panic", "stays selected"] }] })] });
    const result = await run(context());
    expect(result.detail).toMatchObject({
      brief: "Guard the empty list", criteria: ["no panic", "stays selected"], rollback: "revert the commit",
      slices: [{ title: "guard j", touchpoints: ["board/src/keys.rs", "board/src/keys_new.rs"] }],
      plan: {
        goal: "Guard the empty list",
        steps: [{ id: "P1", description: "guard j", files: ["board/src/keys.rs", "board/src/keys_new.rs"], new_files: ["board/src/keys_new.rs"], done_when: ["no panic", "stays selected"] }],
        acceptance_criteria: [{ id: "C1", text: "no panic" }, { id: "C2", text: "stays selected" }],
        out_of_scope: ["the help text"], assumptions: ["board only"], rollback: "revert the commit", migration: "none", flags: ["guard_j"], version: 1,
      },
    });
  });

  it("builds the Plan from a v1 planner answer (slices only): steps from the slices, no migration or flags, version 1", async () => {
    const result = await setup().run(context());
    expect(result.detail?.plan).toMatchObject({ steps: [{ id: "P1", title: "guard j", files: ["board/src/keys.rs"], done_when: ["no panic", "stays selected"] }], out_of_scope: [], version: 1 });
    expect(result.detail?.plan).not.toHaveProperty("migration");
    expect(result.detail?.plan).not.toHaveProperty("flags");
  });

  it("raises the Plan's version with every planner re-run", async () => {
    const { run } = setup({ answers: { plan_check: [bad, bad, good.plan_check] } });
    const result = await run(context());
    expect(result.detail).toMatchObject({ rounds: { plan: 3 }, plan: { version: 3 } });
  });

  it("reads a risk_score answer without the complexity question: the level comes from the three scores and the complexity is left out", async () => {
    const { complexity: _omitted, ...old } = good.risk_score;
    const { run } = setup({ answers: { risk_score: [{ ...old, blast_radius: { score: 2, confidence: 0.9 }, reversibility: { score: 2, confidence: 0.9 } }] } });
    const result = await run(context());
    expect(result.detail).toMatchObject({ risk: { level: "medium", product: 9 }, verdicts: { risk: "proceed" } });
    expect((result.detail?.risk as Record<string, unknown>).complexity).toBeUndefined();
    expect(result.detail?.flagged).toEqual([]);
  });

  it("runs each sub-run under a derived run id, not resumable and not pinned to the stage's engine", async () => {
    const { run, calls } = setup();
    await run(context());
    expect(calls.map((c) => c.runId)).toEqual(["r1-plan", "r1-tests-1"]);
    for (const call of calls) expect(call.context).toMatchObject({ stage: "test_design", started: undefined, resume: undefined, engine: undefined });
  });

  it("hands the test designer the criteria and the goal, and the decisions the plan with its scenarios and the record", async () => {
    const { run, calls, decided } = setup();
    await run(context());
    // The designer is handed the criteria and the record's goal, never the steps, the brief, the assumptions, the map or the risk.
    expect(calls[1]!.plan).toEqual({ record, brief: "", criteria: ["no panic", "stays selected"], assumptions: [], slices: [], round: 1 });
    for (const d of decided.filter((k) => k.pack === "plan_check")) expect(d.plan).toMatchObject({ record, brief: "Guard the empty list", slices, cases: [{ title: "case 0" }, { title: "case 1" }] });
    expect(decided[0]!.repo).toBe("/repo");
  });

  it("keeps the designer blind to the plan on every round and on the fast lane, and tells it only the gaps and its earlier scenarios", async () => {
    const { run, calls } = setup({ test_design: [cased("no panic"), cased("no panic", "stays selected")] }, withGraph);
    await run(context());
    const rounds = calls.filter((c) => c.pack === "test_design");
    expect(rounds).toHaveLength(2);
    expect(rounds[1]!.plan).toEqual({ record, brief: "", criteria: ["no panic", "stays selected"], assumptions: [], slices: [], cases: [{ title: "case 0", criterion: "no panic", approach: "run it" }], gaps: ["stays selected"], coverage_notes: ["C2 has no scenario: stays selected"], round: 2 });
    const fast = setup({}, withGraph);
    await fast.run(context({ task: fastTask }));
    expect(fast.calls.find((c) => c.pack === "test_design_fast")!.plan).toEqual({ record: fastTask.record, brief: "", criteria: ["no panic", "stays selected"], assumptions: [], slices: [], round: 1 });
  });

  it("scores the risk before the plan, from the record and the code map alone, and writes the plan knowing it", async () => {
    const answer = { blast_radius: { score: 2, confidence: 0.9 }, reversibility: { score: 2, confidence: 0.9 }, data_sensitivity: { score: 0, confidence: 0.9 }, complexity: { choice: "L", confidence: 0.8 } };
    const { run, calls, decided } = setup({ answers: { risk_score: [answer] } }, withGraph);
    const result = await run(context());
    // The order is the code map, risk_score, the plan, the scenarios; risk_score needs no plan.
    expect(calls.map((c) => c.pack)).toEqual(["code_map", "plan", "test_design"]);
    expect(decided[0]).toMatchObject({ pack: "risk_score", plan: { record, map: theMap, slices: [], brief: "" } });
    const risk = { level: "medium", product: 9, scores: { blast_radius: 2, reversibility: 2, data_sensitivity: 0 }, complexity: "L" };
    expect(calls[1]!.plan).toMatchObject({ record, risk });
    // The designer reads the criteria and the goal, not the risk the plan was written for.
    expect(calls[2]!.plan).not.toHaveProperty("risk");
    expect(result.detail).toMatchObject({ risk });
  });

  it("keeps the risk on the planner's re-runs and hands it to the plan check", async () => {
    const { run, calls, decided } = setup({ answers: { plan_check: [bad, good.plan_check] } });
    await run(context());
    for (const c of calls.filter((k) => k.pack === "plan")) expect(c.plan).toMatchObject({ risk: { level: "medium", product: 1 } });
    for (const d of decided.filter((k) => k.pack === "plan_check")) expect(d.plan).toMatchObject({ risk: { level: "medium" } });
    expect(decided.filter((d) => d.pack === "risk_score")).toHaveLength(1);
  });

  it("re-runs the test designer with the criteria no case names, until they are all covered", async () => {
    const { run, calls, decided } = setup({ test_design: [cased("no panic"), cased("no panic", "stays selected")] });
    const result = await run(context());
    expect(calls.map((c) => [c.pack, c.runId])).toEqual([["plan", "r1-plan"], ["test_design", "r1-tests-1"], ["test_design", "r1-tests-2"]]);
    expect(calls[2]!.plan).toMatchObject({ gaps: ["stays selected"], round: 2, cases: [{ criterion: "no panic" }] });
    expect(decided.filter((d) => d.pack === "coverage_check")).toHaveLength(2);
    // coverage_check is told no gap: it reads the criteria and the scenarios and the machine counts the rest.
    expect(decided.find((d) => d.pack === "coverage_check")!.plan).toMatchObject({ criteria: ["no panic", "stays selected"], cases: [{ criterion: "no panic" }] });
    expect(result.detail).toMatchObject({ rounds: { tests: 2, plan: 1 }, flagged: [], cases: [{ criterion: "no panic" }, { criterion: "stays selected" }] });
  });

  describe("coverage by id", () => {
    const limited = planned({ criteria: ["no panic", "locks after five failures"] });

    it("sends the designer back when a criterion that names a limit or an error has no edge or failure scenario, with what is missing", async () => {
      const { run, calls } = setup({ plan: [limited], test_design: [scenes(["C1"], ["C2"]), scenes(["C1"], ["C2"], ["C2", "failure"])] });
      const result = await run(context());
      expect(calls.filter((c) => c.pack === "test_design")).toHaveLength(2);
      expect(calls[2]!.plan?.coverage_notes).toEqual([expect.stringMatching(/C2.*edge or failure/)]);
      expect(calls[2]!.plan).toMatchObject({ round: 2, cases: [{ id: "S1" }, { id: "S2" }] });
      expect(result.detail).toMatchObject({ rounds: { tests: 2 }, coverageReport: { score: 1, gaps: [], thin: [] }, flagged: [] });
    });

    it("sends the designer back when coverage_check confidently says a scenario does not pin its criterion", async () => {
      const { run, calls, decided } = setup({ test_design: [scenes(["C1"], ["C2"])], answers: { coverage_check: [notPinned, good.coverage_check] } });
      const result = await run(context());
      expect(calls.filter((c) => c.pack === "test_design")).toHaveLength(2);
      expect(calls[2]!.plan?.coverage_notes).toEqual([expect.stringMatching(/do not each pin/)]);
      expect(decided.filter((d) => d.pack === "coverage_check")).toHaveLength(2);
      expect(result.detail).toMatchObject({ verdicts: { coverage: "proceed" }, flagged: [] });
    });

    it("does not send the designer back for an unsure 'does not pin': that one is flagged for a person", async () => {
      const unsure = { ...notPinned, pins: { value: false, p: 0.4 } };
      const { run, calls } = setup({ test_design: [scenes(["C1"], ["C2"])], answers: { coverage_check: [unsure] } });
      const result = await run(context());
      expect(calls.filter((c) => c.pack === "test_design")).toHaveLength(1);
      expect(result.detail).toMatchObject({ flagged: ["coverage"] });
    });

    it(`stops after ${COVERAGE_ROUNDS} rounds and the gate shows what is still open`, async () => {
      const { run, calls } = setup({ test_design: [scenes(["C1"])] });
      const result = await run(context());
      expect(calls.filter((c) => c.pack === "test_design")).toHaveLength(COVERAGE_ROUNDS);
      expect(result.detail).toMatchObject({ flagged: ["coverage"], coverageReport: { score: 0.5, gaps: ["C2"], open: [expect.stringMatching(/stays selected/)] } });
    });

    it("carries the per-criterion coverage, the score and the repo's bar on the gate", async () => {
      const repo = { policies: { for: async () => ({ decisions: {}, factory: { plan: { coverage_rounds: 3, plan_check_retries: 2, coverage_score_min: 0.6 } } }) } };
      const { run } = setup({ test_design: [scenes(["C1"], ["C2"], ["C2", "edge"])] }, repo);
      const result = await run(context());
      expect(result.detail?.coverageReport).toEqual({
        score: 1, bar: 0.6, gaps: [], thin: [], untestable: [], open: [],
        per: [{ id: "C1", text: "no panic", scenarios: ["S1"], types: ["happy"] }, { id: "C2", text: "stays selected", scenarios: ["S2", "S3"], types: ["happy", "edge"] }],
      });
      const defaults = await setup({ test_design: [scenes(["C1"], ["C2"])] }).run(context());
      expect(defaults.detail?.coverageReport).toMatchObject({ bar: 0.85 });
    });

    it("flags the gate when the score is under the bar even after the last round", async () => {
      const repo = { policies: { for: async () => ({ decisions: {}, factory: { plan: { coverage_rounds: 1, plan_check_retries: 2, coverage_score_min: 0.9 } } }) } };
      const result = await setup({ test_design: [scenes(["C1"])] }, repo).run(context());
      expect(result.detail).toMatchObject({ flagged: ["coverage"], coverageReport: { score: 0.5, bar: 0.9 } });
    });

    it("leaves a criterion coverage_check confidently calls untestable out of the score and the loop", async () => {
      const untestable = { ...good.coverage_check, untestable: { value: true, p: 0.95 } };
      const { run, calls } = setup({ test_design: [scenes(["C1"])], answers: { coverage_check: [untestable] } });
      const result = await run(context());
      expect(calls.filter((c) => c.pack === "test_design")).toHaveLength(1);
      expect(result.detail).toMatchObject({ coverageReport: { score: 1, gaps: ["C2"], untestable: ["C2"] }, flagged: ["coverage"] });
    });

    it("hands coverage_check the criteria with their ids and the scenarios, and no steps, brief, map, risk or record", async () => {
      const { run, decided } = setup({ test_design: [scenes(["C1"], ["C2"])] }, withGraph);
      await run(context());
      const input = decided.find((d) => d.pack === "coverage_check")!.plan;
      expect(input).toMatchObject({ record: null, brief: "", criteria: ["no panic", "stays selected"], assumptions: [], slices: [], cases: [{ id: "S1", criterion_ref: "C1" }, { id: "S2", criterion_ref: "C2" }] });
      expect(input).not.toHaveProperty("map");
      expect(input).not.toHaveProperty("risk");
    });
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

  it("takes the designer's rounds and the planner's re-runs from the repo's luna.yaml `plan` section", async () => {
    const factory = (coverage_rounds: number, plan_check_retries: number) => ({ policies: { for: async () => ({ decisions: {}, factory: { plan: { coverage_rounds, plan_check_retries } } }) } });
    const fewer = setup({ test_design: [cased("no panic")] }, factory(1, 0));
    await fewer.run(context());
    expect(fewer.calls.filter((c) => c.pack === "test_design")).toHaveLength(1);
    const more = setup({ test_design: [cased("no panic")] }, factory(5, 2));
    await more.run(context());
    expect(more.calls.filter((c) => c.pack === "test_design")).toHaveLength(5);
    const noRetry = setup({ answers: { plan_check: [bad] } }, factory(3, 0));
    await noRetry.run(context());
    expect(noRetry.calls.filter((c) => c.pack === "plan")).toHaveLength(1);
    const four = setup({ answers: { plan_check: [bad] } }, factory(3, 4));
    await four.run(context());
    expect(four.calls.filter((c) => c.pack === "plan")).toHaveLength(5);
  });

  it("scores the risk with riskLevelOf and judges each verdict by the pack's bars and the repo's overrides", async () => {
    const risky = { blast_radius: { score: 2, confidence: 0.9 }, reversibility: { score: 2, confidence: 0.4 }, data_sensitivity: { score: 1, confidence: 0.9 }, complexity: { choice: "M", confidence: 0.9 } };
    const { run } = setup({ answers: { risk_score: [risky] } }, { policies: { for: async () => ({ decisions: { risk_score: { reversibility: { flag: 0.3 } } } }) } });
    const result = await run(context());
    expect(result.detail).toMatchObject({ risk: { level: "high", product: 18, scores: { blast_radius: 2, reversibility: 2, data_sensitivity: 1 } }, verdicts: { risk: "flag" }, flagged: ["risk"] });
    // The product, not the sum: 3 x 3 x 1 is medium though the three levels add to 7.
    const wide = { blast_radius: { score: 2, confidence: 0.9 }, reversibility: { score: 2, confidence: 0.9 }, data_sensitivity: { score: 0, confidence: 0.9 }, complexity: { choice: "M", confidence: 0.9 } };
    const { run: runWide } = setup({ answers: { risk_score: [wide] } });
    expect((await runWide(context())).detail).toMatchObject({ risk: { level: "medium", product: 9 } });
  });

  it("never rates the risk below triage's grade: a decision can raise it, not lower it", async () => {
    const mild = good.risk_score;
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
    // Risk is scored before the planner; nothing else is decided after the designer asks.
    expect(second.decided.map((d) => d.pack)).toEqual(["risk_score"]);
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
      expect(decided.map((d) => d.pack)).toEqual(["risk_score", "plan_check"]);
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
      expect(decided.map((d) => d.pack)).toEqual(["risk_score", "coverage_check", "plan_check"]);
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

  it("lists the triage signals that went through under their bar as triage.<field> on the gate", async () => {
    const classification = { kind: "bug", ready: true, size: 1, sizeBucket: "S", priority: "P2", riskPrelim: "low", confidence: 0.9, at: "", model: "m", signals: { kind: { answer: "bug", confidence: 0.7 }, size: { answer: "S", confidence: 0.9 }, risk_prelim: { answer: "low", confidence: 0.9 } } };
    const flagged = await setup({}).run(context({ task: { ...task, classification } as never }));
    expect(flagged.detail).toMatchObject({ flagged: ["triage.kind"] });
  });

  it("lists a fast lane taken without the owners checked on the gate, with why", async () => {
    const record = { source: "manual", kind: "bug", goal: "g", size: "S", urgency: "P3", risk: "low", signals: {}, qa: [], decision: "fast_lane", reason: "r", at: "2026-11-05T00:00:00.000Z", model: "m", ownersNotChecked: "the code graph is stale (80 commits behind)" };
    const flagged = await setup({}).run(context({ task: { ...task, record } as never }));
    expect(flagged.detail?.flagged).toContain("owners not checked: the code graph is stale (80 commits behind)");
    const planned = await setup({}).run(context({ task: { ...task, record: { ...record, decision: "plan" } } as never }));
    expect(planned.detail?.flagged).not.toContain("owners not checked: the code graph is stale (80 commits behind)");
  });
});
