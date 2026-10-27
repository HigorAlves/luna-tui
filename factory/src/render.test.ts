import { PACKS, type StageInput } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import { FACTORY_RULES, renderPrompt } from "./render.ts";

const input: StageInput = {
  schema: 3,
  stage: "implementing",
  pack: "implementing",
  attempt: 2,
  task: { id: "t1", title: "Fix the bug", description: "It breaks & crashes", criteria: ["no crash", "a/b"], repoPath: "/r", branch: "task/t1-fix", source: null },
  plan: { brief: "do it", criteria: ["c1"], assumptions: ["a1"], slices: [{ title: "s1", est_loc: 10, touchpoints: ["a.ts"], acceptance: ["ok"] }] },
  decisions: [
    { at: "triage", decision: "answered", reason: null, answers: { Q: "A" } },
    { at: "awaiting_approval", decision: "approved", reason: "go", answers: {} },
  ],
  priorFindings: [{ path: "a.ts", line: 3, severity: "bug", title: "null deref", body: "", confidence: 0.9 }],
  context: { projectContext: null, testCases: [{ title: "t", criterion: "c1", approach: "run it" }] },
  limits: { maxTurns: 10, timeoutMs: 1000 },
  env: { LUNA_FACTORY: "1" },
};

describe("renderPrompt", () => {
  const template = [
    "# {{agent}} attempt {{attempt}} on {{task.branch}}",
    "{{task.title}}: {{task.description}}",
    "criteria:\n{{task.criteria}}",
    "brief: {{plan.brief}}\nslices:\n{{plan.slices}}",
    "decisions:\n{{decisions}}",
    "findings:\n{{priorFindings}}",
    "cases:\n{{context.testCases}}",
    "context: {{context.projectContext}}",
    "skills: {{skills}}",
  ].join("\n");

  it("fills every placeholder, keeping user text verbatim (slashes and ampersands included)", () => {
    const prompt = renderPrompt({ pack: PACKS.implementing, input, template, projectContext: "Rules here" });
    expect(prompt).toContain("# implementer attempt 2 on task/t1-fix");
    expect(prompt).toContain("Fix the bug: It breaks & crashes");
    expect(prompt).toContain("- no crash\n- a/b");
    expect(prompt).toContain("1. s1 (~10 LOC; touches a.ts): ok");
    expect(prompt).toContain('- answered at triage: {"Q":"A"}\n- approved at awaiting_approval: go');
    expect(prompt).toContain("- bug a.ts:3 null deref");
    expect(prompt).toContain("- t (criterion: c1): run it");
    expect(prompt).toContain("context: Rules here");
    expect(prompt).toContain("skills: tdd, verification-before-completion, code-discovery");
    expect(prompt).not.toContain("{{");
  });

  it("prefers the input's project context over the worktree file, and prints (none) for what is missing", () => {
    const withContext = { ...input, context: { ...input.context, projectContext: "From input" } };
    expect(renderPrompt({ pack: PACKS.implementing, input: withContext, template, projectContext: "file" })).toContain("context: From input");
    const bare = { ...input, plan: null, decisions: [], priorFindings: [], context: { projectContext: null } };
    const prompt = renderPrompt({ pack: PACKS.triage, input: bare, template });
    expect(prompt).toContain("brief: (none)\nslices:\n(none)");
    expect(prompt).toContain("decisions:\n(none)");
    expect(prompt).toContain("context: (none)");
  });

  it("opens with the role, the stage, the factory rules and the answer schema", () => {
    const prompt = renderPrompt({ pack: PACKS.triage, input: { ...input, pack: "triage", stage: "triage" }, template: "body" });
    const [header, schema] = prompt.split("\n");
    expect(header).toContain("`triage-planner` role running the `triage` stage in factory mode (LUNA_FACTORY=1)");
    expect(header).toContain("Never call AskUserQuestion");
    const parsed = JSON.parse(schema!);
    expect(parsed.properties.kind.enum).toEqual(["brief", "questions"]);
    expect(parsed.$schema).toBeUndefined();
    expect(prompt.endsWith("\nbody")).toBe(true);
  });

  it("renders the CI facts, the base commit and the QA targets for the packs that read them", () => {
    const template = "base {{context.baseCommit}}\nci:\n{{context.ci}}\ntargets:\n{{context.qaTargets}}";
    const ci = { pr: { number: 7, url: "https://x/pr/7" }, checks: [{ name: "test", state: "failure", url: null }], logs: "FAIL a.test.ts" };
    const qaTargets = [{ name: "staging", baseUrl: "https://stg.example.com", credential: "env:QA_PASSWORD" }, { name: "local", baseUrl: "http://127.0.0.1:3000", credential: null }];
    const rich = { ...input, context: { ...input.context, baseCommit: "9c1f0e2a", ci, qaTargets } };
    const prompt = renderPrompt({ pack: PACKS.ci_watch, input: rich, template });
    expect(prompt).toContain("base 9c1f0e2a");
    expect(prompt).toContain("PR #7 (https://x/pr/7)\nChecks:\n- test: failure\nFailed run log tail:\n```\nFAIL a.test.ts\n```");
    expect(prompt).toContain("- staging: https://stg.example.com (credential: env:QA_PASSWORD)\n- local: http://127.0.0.1:3000");
    const bare = renderPrompt({ pack: PACKS.ci_watch, input, template });
    expect(bare).toContain("base (none)\nci:\n(none)\ntargets:\n(none)");
  });

  it("names a script pack's agent as script", () => {
    expect(renderPrompt({ pack: PACKS.evidence, input: { ...input, pack: "evidence", stage: "evidence" }, template: "{{agent}}" })).toMatch(/\nscript$/);
  });

  it("states the rules a stage runs under", () => {
    expect(FACTORY_RULES).toContain("Never call AskUserQuestion");
    expect(FACTORY_RULES).toContain("requested[]");
    expect(FACTORY_RULES).toContain("Never write outside /work and /out");
  });
});
