import { readFileSync } from "node:fs";
import { join } from "node:path";

import { StageInput } from "@hardness/contracts";
import { Ajv2020 } from "ajv/dist/2020.js";
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
    expect(input.env).toEqual({ ORC_FACTORY: "1" });
  });

  // orc's packs, vendored by `pnpm vendor:orc`; the two copies of these limits must agree,
  // since the machine enforces timeoutMs on the container and writable on the mount.
  const orcFixtures = join(import.meta.dirname, "..", "..", "..", "contracts", "fixtures", "orc");
  const orcPacks = JSON.parse(readFileSync(join(orcFixtures, "stages.json"), "utf8")).packs as Record<string, { maxTurns: number; timeoutMs: number; writable: boolean }>;

  it("mirrors every pack's maxTurns, timeoutMs and writable from orc's stages.json", () => {
    for (const [pack, limits] of Object.entries(PACK_LIMITS)) {
      const theirs = orcPacks[pack];
      expect(theirs, `orc has no pack ${pack}`).toBeDefined();
      expect(limits, pack).toEqual({ maxTurns: theirs!.maxTurns, timeoutMs: theirs!.timeoutMs, writable: theirs!.writable });
    }
  });

  it("builds an input orc's own stage-input schema accepts", () => {
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    const validate = ajv.compile(JSON.parse(readFileSync(join(orcFixtures, "stage-input.json"), "utf8")));
    const cases = [{ title: "t", criterion: "c", approach: "a" }];
    const approvals = [
      approval({ requested: { brief: "do it", criteria: ["c1"], assumptions: [], slices } }),
      approval({ kind: "awaiting_test_check", requested: { cases } }),
    ];
    for (const stage of ["triage", "implementing", "verifying"] as const) {
      const input = buildStageInput({ task, stage, attempt: 1, approvals, priorFindings: [finding(0.9, "keep")] });
      expect(validate(input), `${stage}: ${JSON.stringify(validate.errors)}`).toBe(true);
    }
  });

  it("has no plan before one is approved, and covers all eight packs", () => {
    const input = buildStageInput({ task, stage: "triage", attempt: 1, approvals: [], priorFindings: [] });
    expect(input.plan).toBeNull();
    expect(Object.keys(PACK_LIMITS).sort()).toEqual(
      ["ci_watch", "e2e", "evidence", "implementing", "reviewing_memory", "test_design", "triage", "verifying"],
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
});
