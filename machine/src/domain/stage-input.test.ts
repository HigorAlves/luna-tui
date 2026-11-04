import { PACKS, type PackId, StageInput } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import type { ApprovalRow, TaskRow } from "./task.ts";
import { PACK_LIMITS, buildJiraIntakeInput, buildSlackTriageInput, buildStageInput } from "./stage-input.ts";

const task = {
  id: "t1",
  title: "Fix the bug",
  description: "It breaks",
  criteria: ["no crash"],
  repoPath: "/repo",
  branch: "task/t1-fix",
  source: { kind: "github", repo: "o/n", number: 7, url: "https://github.com/o/n/issues/7" },
} as unknown as TaskRow;

describe("buildStageInput's task", () => {
  it("carries the ticket's classification, null when it has none", () => {
    const classification = { kind: "bug", area: "board", ready: true, size: 1, confidence: 0.8, at: "2026-11-04T00:00:00.000Z", model: "m" };
    const build = (t: unknown) => buildStageInput({ task: t as TaskRow, stage: "triage", attempt: 1, approvals: [], priorFindings: [] });
    expect(build({ ...task, classification }).task.classification).toEqual(classification);
    expect(StageInput.parse(build({ ...task, classification })).task.classification).toEqual(classification);
    expect(build({ ...task, classification: null }).task.classification).toBeNull();
  });
});

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

describe("buildStageInput's pack and plan", () => {
  const slices = [{ title: "s", est_loc: 5, touchpoints: ["a.ts"], acceptance: ["ok"] }];
  const planContext = { record: null, brief: "the plan", criteria: ["c1"], assumptions: ["a1"], slices, rollback: "revert", gaps: ["c1"], round: 2 };

  it("runs a pack other than the state's own when asked: the planner in test_design, with that pack's limits", () => {
    const input = buildStageInput({ task, stage: "test_design", pack: "plan", attempt: 1, approvals: [], priorFindings: [] });
    expect(input).toMatchObject({ stage: "test_design", pack: "plan", limits: { maxTurns: PACK_LIMITS.plan.maxTurns, timeoutMs: PACK_LIMITS.plan.timeoutMs } });
    expect(buildStageInput({ task, stage: "test_design", attempt: 1, approvals: [], priorFindings: [] }).pack).toBe("test_design");
  });

  it("hands a plan under review to the stage: context.plan as given, and the plan every stage reads rebuilt from it before any approval", () => {
    const input = buildStageInput({ task, stage: "test_design", attempt: 1, approvals: [], priorFindings: [], plan: planContext });
    expect(input.context.plan).toEqual(planContext);
    expect(input.plan).toEqual({ brief: "the plan", criteria: ["c1"], assumptions: ["a1"], slices, rollback: "revert" });
    expect(StageInput.safeParse(input).success).toBe(true);
  });

  it("reads rollback and the cases from the approved plan, and the cases reach implementing without a test check", () => {
    const cases = [{ title: "t", criterion: "c1", approach: "run a.test.ts" }];
    const approvals = [approval({ requested: { brief: "b", criteria: ["c1"], assumptions: [], slices, rollback: "revert it", cases } })];
    const input = buildStageInput({ task, stage: "implementing", attempt: 1, approvals, priorFindings: [] });
    expect(input.plan).toMatchObject({ brief: "b", rollback: "revert it", slices });
    expect(input.context.testCases).toEqual(cases);
    // The code map the plan stage opened with rides along; a malformed one is dropped.
    const map = { components: ["export"], files: ["src/a.ts"], owners: ["@marta"], confidence: 0.8 };
    const mapped = [approval({ requested: { brief: "b", criteria: [], assumptions: [], slices, map } })];
    expect(buildStageInput({ task, stage: "implementing", attempt: 1, approvals: mapped, priorFindings: [] }).plan).toMatchObject({ map });
    const broken = [approval({ requested: { brief: "b", criteria: [], assumptions: [], slices, map: { files: 3 } } })];
    expect(buildStageInput({ task, stage: "implementing", attempt: 1, approvals: broken, priorFindings: [] }).plan).not.toHaveProperty("map");
    // A legacy test check, when one exists, still wins.
    const legacy = [...approvals, approval({ kind: "awaiting_test_check", requested: { cases: [{ title: "legacy", criterion: null, approach: "x" }] } })];
    expect(buildStageInput({ task, stage: "implementing", attempt: 1, approvals: legacy, priorFindings: [] }).context.testCases).toEqual([{ title: "legacy", criterion: null, approach: "x" }]);
  });
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

  it("carries the task's triage record and evidence pack into the input", () => {
    const record = { source: "github", kind: "bug", goal: "g", size: "small", urgency: "normal", risk: "low" as const, signals: {}, qa: [], decision: "plan" as const, reason: "r", at: "2026-11-03T12:00:00.000Z", model: "m" };
    const input = buildStageInput({ task: { ...task, record, evidence: null }, stage: "implementing", attempt: 1, approvals: [], priorFindings: [] });
    expect(StageInput.safeParse(input).success).toBe(true);
    expect(input.task.record).toEqual(record);
    expect(input.task.evidence).toBeNull();
  });

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
    expect(input.context).toEqual({ projectContext: null, testCases: [], baseCommit: "9c1f0e2a", ci: null, graph: null });
    expect(input.limits).toEqual({ maxTurns: 80, timeoutMs: 1_800_000 });
    expect(input.env).toEqual({ LUNA_FACTORY: "1" });
  });

  it("carries the coverage summary to verifying only", () => {
    const coverage = { files: [{ path: "src/a.ts", added: 4, covered: 3, uncovered: [12] }], total: { added: 4, covered: 3 }, report: "coverage/lcov.info" };
    const build = (stage: "verifying" | "implementing") => buildStageInput({ task, stage, attempt: 1, approvals: [], priorFindings: [], coverage });
    expect(build("verifying").context.coverage).toEqual(coverage);
    expect(build("implementing").context).not.toHaveProperty("coverage");
  });

  it("carries the blast radius to verifying only, and nothing when there is none", () => {
    const build = (stage: "verifying" | "implementing", blastRadius?: string[]) => buildStageInput({ task, stage, attempt: 1, approvals: [], priorFindings: [], ...(blastRadius ? { blastRadius } : {}) });
    expect(build("verifying", ["src/b.ts"]).context.blastRadius).toEqual(["src/b.ts"]);
    expect(build("implementing", ["src/b.ts"]).context).not.toHaveProperty("blastRadius");
    expect(build("verifying", []).context).not.toHaveProperty("blastRadius");
  });

  it("carries the repo's code graph when the machine has one, null when it has none", () => {
    const graph = { path: "/graph/graphify-out/graph.json", commit: "9c1f0e2a", builtAt: "2026-11-04T10:00:00Z", fresh: true };
    const build = (g?: typeof graph | null) => buildStageInput({ task, stage: "triage", attempt: 1, approvals: [], priorFindings: [], ...(g !== undefined ? { graph: g } : {}) });
    expect(build(graph).context.graph).toEqual(graph);
    expect(StageInput.safeParse(build(graph)).success).toBe(true);
    expect(build().context.graph).toBeNull();
    expect(build(null).context.graph).toBeNull();
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

  it("has no plan before one is approved, and covers all eleven stage packs plus the on-demand ones", () => {
    const input = buildStageInput({ task, stage: "triage", attempt: 1, approvals: [], priorFindings: [] });
    expect(input.plan).toBeNull();
    expect(Object.keys(PACK_LIMITS).sort()).toEqual(
      ["addressing", "chat_triage", "ci_watch", "code_map", "coverage_check", "e2e", "e2e_failure_cause", "eval_judge", "evidence", "evidence_format", "finding_classify", "implementing", "jira_intake", "plan", "plan_check", "plan_fast", "red_check", "reviewing", "reviewing_memory", "risk_score", "scope_check", "setup", "slack_triage", "test_design", "test_design_fast", "triage", "triage_signals", "verifying"],
    );
    expect(Object.keys(PACK_LIMITS)).toHaveLength(28);
  });

  it("builds slack_triage's input around a synthetic task: the batch in context.slack, no plan, no branch, the pack's limits", () => {
    const slack = {
      me: { id: "U1", name: "higor" },
      watches: [{ label: "@platform-team", kind: "usergroup" }],
      rules: "## Notes\n- short\n",
      items: [{ id: "C1:1", channel: "#eng", author: "@marta", isBot: false, text: "hi?", context: [], matched: ["me"], threadReplies: 0 }],
    };
    const input = buildSlackTriageInput(slack);
    const parsed = StageInput.safeParse(input);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(input).toMatchObject({ pack: "slack_triage", stage: "slack_triage", attempt: 1, plan: null, task: { id: "slack-triage", title: "Slack triage", branch: "", repoPath: "", source: null } });
    expect(input.context).toEqual({ projectContext: null, slack });
    expect(input.limits).toEqual({ maxTurns: 3, timeoutMs: 180_000 });
  });

  it("builds jira_intake's input around the issue: the summary as the title, the repo as the (read-only) worktree, the issue in context.jira", () => {
    const jira = {
      key: "PLAT-123",
      url: "https://acme.atlassian.net/browse/PLAT-123",
      summary: "Login page",
      description: "Users sign in.\n\n- bad password errors",
      issueType: "Story",
      priority: "High",
      labels: ["luna"],
      dueAt: "2026-10-31",
      comments: ["Marta: please"],
      repoPath: "/r/a",
    };
    const input = buildJiraIntakeInput(jira);
    const parsed = StageInput.safeParse(input);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(input).toMatchObject({ pack: "jira_intake", stage: "jira_intake", attempt: 1, plan: null, task: { id: "jira-intake", title: "Login page", description: jira.description, criteria: [], repoPath: "/r/a", branch: "", source: null } });
    expect(input.context).toEqual({ projectContext: null, jira });
    expect(input.limits).toEqual({ maxTurns: 8, timeoutMs: 300_000 });
    expect(buildJiraIntakeInput({ ...jira, repoPath: null }).task.repoPath).toBe("");
  });

  it("carries what the host fetched for ci_watch, and nothing test_design never wrote", () => {
    const ci = {
      pr: { number: 42, url: "https://x/pull/42" },
      checks: [{ name: "machine", state: "FAILURE", url: "https://x/runs/9" }],
      logs: "FAIL src/a.test.ts > boom",
    };
    const input = buildStageInput({ task, stage: "ci_watch", attempt: 1, approvals: [], priorFindings: [], ci });
    expect(input.context).toEqual({ projectContext: null, testCases: [], baseCommit: null, ci, graph: null });
    expect(StageInput.safeParse(input).success).toBe(true);
    expect("tests" in input.context).toBe(false);
  });

  it("gives implementing and verifying the test cases approved at the test check (schema 2)", () => {
    const cases = [
      { title: "rejects a bad password", criterion: "no crash", approach: "run src/a.test.ts, confirm it rejects" },
      { title: "an edge case", criterion: null, approach: "run src/b.test.ts" },
    ];
    const approvals = [
      approval({ kind: "awaiting_test_check", requested: { cases: [...cases, "junk", { title: "older", criterion: null, test: "run c.test.ts" }] } }),
    ];
    const at = (stage: "implementing" | "verifying" | "e2e") =>
      buildStageInput({ task, stage, attempt: 1, approvals, priorFindings: [] });
    expect(at("implementing").schema).toBe(3);
    // A case recorded under schema 2 (`test`) reads as today's `approach`.
    cases.push({ title: "older", criterion: null, approach: "run c.test.ts" });
    expect(at("implementing").context.testCases).toEqual(cases);
    expect(at("verifying").context.testCases).toEqual(cases);
    // e2e drives the approved scenarios, as verifying does.
    expect(at("e2e").context.testCases).toEqual(cases);
    expect(StageInput.safeParse(at("verifying")).success).toBe(true);
  });

  it("hands implementing and verifying the repo's checks from luna.yaml, and no other pack", () => {
    const checks = [{ name: "board tests", run: "cargo test", cwd: "board", paths: ["board/**"] }];
    const build = (stage: Exclude<PackId, "plan" | "code_map" | "plan_fast" | "test_design_fast" | "risk_score" | "coverage_check" | "plan_check" | "red_check" | "scope_check" | "finding_classify" | "e2e_failure_cause" | "evidence_format" | "slack_triage" | "jira_intake" | "triage_signals" | "eval_judge" | "chat_triage">) => buildStageInput({ task, stage, attempt: 1, approvals: [], priorFindings: [], checks });
    expect(build("implementing").context.checks).toEqual(checks);
    expect(build("verifying").context.checks).toEqual(checks);
    expect(build("triage").context.checks).toBeUndefined();
    expect(StageInput.safeParse(build("implementing")).success).toBe(true);
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
