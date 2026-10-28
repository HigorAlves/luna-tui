import { PACKS, type PackId, StageInput } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import type { ApprovalRow, TaskRow } from "./task.ts";
import { PACK_LIMITS, buildStageInput } from "./stage-input.ts";

const task = {
  id: "t1",
  title: "Fix the bug",
  description: "It breaks",
  criteria: ["no crash"],
  repoPath: "/repo",
  branch: "task/t1-fix",
  source: { kind: "github", repo: "o/n", number: 7, url: "https://github.com/o/n/issues/7" },
} as unknown as TaskRow;

const approval = (over: Partial<ApprovalRow>): ApprovalRow =>
  ({
    id: "a",
    taskId: "t1",
    kind: "awaiting_approval",
    requested: {},
    decision: "approved",
    reason: null,
    response: null,
    createdAt: new Date(0),
    decidedAt: new Date(0),
    ...over,
  }) as ApprovalRow;

const finding = (confidence: number, title: string) => ({
  path: "a.ts",
  line: 1,
  start_line: null,
  severity: "bug",
  title,
  body: "",
  suggestion_code: null,
  confidence,
});

describe("buildStageInput", () => {
  const slices = [{ title: "s", est_loc: 5, touchpoints: ["a.ts"], acceptance: ["ok"] }];
  const approvals = [
    approval({ kind: "triage", decision: "answered", response: { answers: { Q: "A" } } }),
    approval({
      requested: { brief: "old", criteria: ["c0"], assumptions: [] },
      decision: "sent_back",
      reason: "redo",
    }),
    approval({
      requested: { brief: "do it", criteria: ["c1"], assumptions: ["a1"], slices },
      reason: "go",
    }),
  ];

  it("builds an input that passes the contract", () => {
    const input = buildStageInput({
      task,
      stage: "implementing",
      attempt: 2,
      approvals,
      priorFindings: [finding(0.9, "keep"), finding(0.79, "drop"), finding(0.8, "edge")],
      baseCommit: "9c1f0e2a",
    });
    expect(StageInput.safeParse(input).success).toBe(true);
    expect(input.pack).toBe("implementing");
    expect(input.attempt).toBe(2);
    expect(input.task.source).toEqual(task.source);
    expect(input.plan).toEqual({ brief: "do it", criteria: ["c1"], assumptions: ["a1"], slices });
    expect(input.decisions).toEqual([
      { at: "triage", decision: "answered", reason: null, answers: { Q: "A" } },
      { at: "awaiting_approval", decision: "sent_back", reason: "redo", answers: {} },
      { at: "awaiting_approval", decision: "approved", reason: "go", answers: {} },
    ]);
    expect(input.priorFindings.map((f) => f.title)).toEqual(["keep", "edge"]);
    expect(input.context).toEqual({ projectContext: null, testCases: [], baseCommit: "9c1f0e2a", ci: null });
    expect(input.limits).toEqual({ maxTurns: 80, timeoutMs: 1_800_000 });
    expect(input.env).toEqual({ LUNA_FACTORY: "1" });
  });

  it("sizes implementing's budget to the plan: turns and time scale with the slice count, up to four times", () => {
    const sliced = (n: number) => [approval({ requested: { brief: "b", criteria: [], assumptions: [], slices: Array.from({ length: n }, (_, i) => ({ ...slices[0]!, title: `s${i}` })) } })];
    const limitsFor = (stage: "implementing" | "verifying", n: number) =>
      buildStageInput({ task, stage, attempt: 1, approvals: sliced(n), priorFindings: [] }).limits;
    expect(limitsFor("implementing", 1)).toEqual({ maxTurns: 80, timeoutMs: 1_800_000 });
    expect(limitsFor("implementing", 3)).toEqual({ maxTurns: 240, timeoutMs: 5_400_000 });
    expect(limitsFor("implementing", 6)).toEqual({ maxTurns: 320, timeoutMs: 7_200_000 });
    expect(limitsFor("verifying", 3)).toEqual({ maxTurns: 60, timeoutMs: 1_200_000 });
  });

  it("takes every pack's maxTurns, timeoutMs and writable from the contracts' pack registry", () => {
    for (const [pack, limits] of Object.entries(PACK_LIMITS)) {
      const theirs = PACKS[pack as PackId];
      expect(limits, pack).toEqual({ maxTurns: theirs.maxTurns, timeoutMs: theirs.timeoutMs, writable: theirs.writable });
    }
  });

  it("builds an input the stage-input contract accepts, with the repo's QA targets and the task's history when given", () => {
    const cases = [{ title: "t", criterion: "c", approach: "a" }];
    const approvals = [
      approval({ requested: { brief: "do it", criteria: ["c1"], assumptions: [], slices } }),
      approval({ kind: "awaiting_test_check", requested: { cases } }),
    ];
    const qaTargets = [{ name: "local", baseUrl: "http://127.0.0.1:3000", credential: null }];
    const history = { ledger: { schema: 1 as const, slices: [] }, runs: [{ stage: "implementing", attempt: 1, outcome: "pass", turns: 3, costUsd: 0.1 }] };
    for (const stage of ["triage", "implementing", "verifying", "e2e", "reviewing_memory"] as const) {
      const input = buildStageInput({ task, stage, attempt: 1, approvals, priorFindings: [finding(0.9, "keep")], qaTargets, history });
      const parsed = StageInput.safeParse(input);
      expect(parsed.success, `${stage}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
      expect(input.context.qaTargets).toEqual(stage === "e2e" ? qaTargets : undefined);
      expect(input.context.ledger).toEqual(stage === "reviewing_memory" || stage === "implementing" ? history.ledger : undefined);
      expect(input.context.runs).toEqual(stage === "reviewing_memory" ? history.runs : undefined);
    }
  });

  it("has no plan before one is approved, and covers all ten packs", () => {
    const input = buildStageInput({ task, stage: "triage", attempt: 1, approvals: [], priorFindings: [] });
    expect(input.plan).toBeNull();
    expect(Object.keys(PACK_LIMITS).sort()).toEqual(
      ["addressing", "ci_watch", "e2e", "evidence", "implementing", "reviewing", "reviewing_memory", "test_design", "triage", "verifying"],
    );
  });

  it("carries what the host fetched for ci_watch, and nothing test_design never wrote", () => {
    const ci = {
      pr: { number: 42, url: "https://x/pull/42" },
      checks: [{ name: "machine", state: "FAILURE", url: "https://x/runs/9" }],
      logs: "FAIL src/a.test.ts > boom",
    };
    const input = buildStageInput({ task, stage: "ci_watch", attempt: 1, approvals: [], priorFindings: [], ci });
    expect(input.context).toEqual({ projectContext: null, testCases: [], baseCommit: null, ci });
    expect(StageInput.safeParse(input).success).toBe(true);
    expect("tests" in input.context).toBe(false);
  });

  it("gives implementing and verifying the test cases approved at the test check (schema 2)", () => {
    const cases = [
      { title: "rejects a bad password", criterion: "no crash", approach: "run src/a.test.ts, confirm it rejects" },
      { title: "an edge case", criterion: null, approach: "run src/b.test.ts" },
    ];
    const approvals = [
      approval({ kind: "awaiting_test_check", requested: { cases: [...cases, "junk"] } }),
    ];
    const at = (stage: "implementing" | "verifying" | "e2e") =>
      buildStageInput({ task, stage, attempt: 1, approvals, priorFindings: [] });
    expect(at("implementing").schema).toBe(3);
    expect(at("implementing").context.testCases).toEqual(cases);
    expect(at("verifying").context.testCases).toEqual(cases);
    expect(at("e2e").context.testCases).toEqual([]);
    expect(StageInput.safeParse(at("verifying")).success).toBe(true);
  });

  it("holds the cases out of implementing's input when the repo's policy says so; verifying still sees them", () => {
    const cases = [{ title: "rejects a bad password", criterion: null, approach: "run a.test.ts" }];
    const approvals = [approval({ kind: "awaiting_test_check", requested: { cases } })];
    const at = (stage: "implementing" | "verifying") =>
      buildStageInput({ task, stage, attempt: 1, approvals, priorFindings: [], holdoutCases: true });
    expect(at("implementing").context.testCases).toEqual([]);
    expect(at("verifying").context.testCases).toEqual(cases);
  });
});
