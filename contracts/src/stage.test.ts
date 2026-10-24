import { describe, expect, it } from "vitest";

import { ArtifactKind, PackId, StageInput, StageOutput, TaskState } from "./index.ts";

// The two examples are copied verbatim from the cross-repo contract in the orc plan.
const stageInputExample = {
  schema: 1,
  stage: "implementing",
  pack: "implementing",
  attempt: 1,
  task: {
    id: "uuid",
    title: "",
    description: "",
    criteria: [],
    repoPath: "/abs",
    branch: "task/<id>-<slug>",
    source: { kind: "github", repo: "owner/name", number: 42, url: "" },
  },
  plan: { brief: "", criteria: [], assumptions: [] },
  decisions: [{ at: "awaiting_approval", decision: "approved", reason: null, answers: {} }],
  priorFindings: [],
  context: { projectContext: null, tests: [] },
  limits: { maxTurns: 80, timeoutMs: 1800000 },
  env: { ORC_FACTORY: "1" },
};

const stageOutputExample = {
  schema: 1,
  ok: true,
  outcome: "pass",
  summary: "",
  needsInput: null,
  requested: [],
  findings: [],
  artifacts: [{ kind: "qa-manifest", path: "files/qa/qa-manifest.json", label: "", sha256: "" }],
  slices: { done: 0, total: 0 },
  commit: null,
  usage: { turns: 0, costUsd: null, durationMs: 0, model: "" },
  error: null,
  rateLimited: false,
  resetsAt: null,
};

describe("StageInput", () => {
  it("parses the contract example", () => {
    expect(StageInput.safeParse(stageInputExample).success).toBe(true);
  });

  it("keeps the slices triage proposes in the plan", () => {
    const slices = [{ title: "a", est_loc: 10, touchpoints: ["x.ts"], acceptance: ["works"] }];
    const parsed = StageInput.parse({ ...stageInputExample, plan: { ...stageInputExample.plan, slices } });
    expect(parsed.plan?.slices).toEqual(slices);
  });

  it("allows a null plan and source", () => {
    const input = { ...stageInputExample, plan: null, task: { ...stageInputExample.task, source: null } };
    expect(StageInput.safeParse(input).success).toBe(true);
  });

  it("rejects an unknown pack", () => {
    expect(StageInput.safeParse({ ...stageInputExample, pack: "deploying" }).success).toBe(false);
  });
});

describe("StageOutput", () => {
  it("parses the contract example", () => {
    expect(StageOutput.safeParse(stageOutputExample).success).toBe(true);
  });

  it("parses with and without the optional answer", () => {
    expect(StageOutput.safeParse({ ...stageOutputExample, answer: { kind: "done", criteria: ["a"] } }).success).toBe(true);
    expect(StageOutput.safeParse({ ...stageOutputExample, answer: null }).success).toBe(true);
    expect(StageOutput.safeParse(stageOutputExample).success).toBe(true);
    expect(StageOutput.safeParse({ ...stageOutputExample, answer: "text" }).success).toBe(false);
  });

  it("reads schema 2, which adds the escalated outcome, and still reads schema 1", () => {
    expect(StageOutput.safeParse({ ...stageOutputExample, schema: 2, outcome: "escalated" }).success).toBe(true);
    expect(StageOutput.safeParse({ ...stageOutputExample, schema: 2 }).success).toBe(true);
    expect(StageOutput.safeParse({ ...stageOutputExample, schema: 1, outcome: "escalated" }).success).toBe(false);
    expect(StageOutput.safeParse({ ...stageOutputExample, schema: 3 }).success).toBe(false);
  });

  it("rejects a broken outcome", () => {
    expect(StageOutput.safeParse({ ...stageOutputExample, outcome: "maybe" }).success).toBe(false);
  });

  it("rejects a wrong artifact kind", () => {
    const output = { ...stageOutputExample, artifacts: [{ kind: "gif", path: "a", label: "", sha256: "" }] };
    expect(StageOutput.safeParse(output).success).toBe(false);
  });

  it("parses needs_input with questions", () => {
    const output = {
      ...stageOutputExample,
      outcome: "needs_input",
      needsInput: [{ question: "Which db?", recommended: "postgres" }],
    };
    expect(StageOutput.safeParse(output).success).toBe(true);
  });
});

describe("PackId", () => {
  it("has the eight packs, each named after a task state", () => {
    expect([...PackId.options].sort()).toEqual(
      ["triage", "test_design", "implementing", "verifying", "e2e", "evidence", "ci_watch", "reviewing_memory"].sort(),
    );
    for (const pack of PackId.options) expect(TaskState.options).toContain(pack);
  });
});

describe("ArtifactKind", () => {
  it("lists the nine kinds", () => {
    expect(ArtifactKind.options).toHaveLength(9);
  });
});
