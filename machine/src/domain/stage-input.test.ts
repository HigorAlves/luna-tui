import { StageInput } from "@hardness/contracts";
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
      tests: ["tests/a.test.ts"],
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
    expect(input.context).toEqual({ projectContext: null, tests: ["tests/a.test.ts"] });
    expect(input.limits).toEqual({ maxTurns: 80, timeoutMs: 1_800_000 });
    expect(input.env).toEqual({ ORC_FACTORY: "1" });
  });

  it("has no plan before one is approved, and covers all eight packs", () => {
    const input = buildStageInput({ task, stage: "triage", attempt: 1, approvals: [], priorFindings: [] });
    expect(input.plan).toBeNull();
    expect(Object.keys(PACK_LIMITS).sort()).toEqual(
      ["ci_watch", "e2e", "evidence", "implementing", "reviewing_memory", "test_design", "triage", "verifying"],
    );
  });

  it("gives the implementer the test files from the test check approval", () => {
    const input = buildStageInput({
      task,
      stage: "implementing",
      attempt: 1,
      approvals: [
        approval({ kind: "awaiting_test_check", requested: { summary: "s", tests: ["src/a.test.ts", "src/b.test.ts"] } }),
      ],
      priorFindings: [],
    });
    expect(input.context.tests).toEqual(["src/a.test.ts", "src/b.test.ts"]);
  });
});
