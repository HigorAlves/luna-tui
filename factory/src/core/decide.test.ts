import { PACKS, type StageInput } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import { decisionSummary, renderCheck, renderDecision, renderPlan, stateOf } from "./decide.ts";

const questions = PACKS.triage_signals.questions;

describe("renderDecision", () => {
  it("puts the state first, then every question with its type and labels, then the answer rule", () => {
    const text = renderDecision(questions, { title: "Board panics on key", description: "Pressing j on an empty list panics." });
    expect(text).toContain("# State\n");
    expect(text).toContain("Board panics on key");
    expect(text).toContain("## kind (choice)");
    expect(text).toContain("- bug: Something that works, or should work, is broken");
    expect(text).toContain("## ready (yes or no)");
    expect(text).toContain("## size (score)");
    expect(text).toContain("- 0 tiny:");
    expect(text).toMatch(/Answer only with the JSON object the schema asks for/);
    expect(text).toMatch(/confidence/);
  });
});

describe("stateOf", () => {
  it("prefers context.issue and falls back to the task's title and description", () => {
    const base = { task: { title: "T", description: "D" }, context: {} } as unknown as StageInput;
    expect(stateOf(base)).toEqual({ title: "T", description: "D" });
    expect(stateOf({ ...base, context: { issue: { title: "I", description: "E" } } } as unknown as StageInput)).toEqual({ title: "I", description: "E" });
  });
});

describe("a plan as the state", () => {
  const plan = {
    record: { source: "github", kind: "bug", goal: "Stop the panic", size: "small", urgency: "high", risk: "low", signals: {}, qa: [], decision: "plan", reason: "one function", at: "2026-11-04T00:00:00.000Z", model: "m" },
    brief: "Guard the empty list in the key handler",
    criteria: ["no panic on j", "list stays selected"],
    assumptions: ["board only"],
    slices: [{ title: "guard j", est_loc: 12, touchpoints: ["board/src/keys.rs"], acceptance: ["no panic on j"] }],
    rollback: "Revert the commit; nothing else changes.",
    cases: [{ title: "j on empty", criterion: "no panic on j", approach: "cargo test keys::empty" }],
    gaps: ["list stays selected"],
  };
  const input = { task: { title: "t", description: "d" }, context: { plan } } as unknown as StageInput;

  it("renders the record, brief, criteria, slices, rollback, scenarios by criterion and the gaps", () => {
    const text = renderPlan(plan as never);
    expect(text).toContain("Goal: Stop the panic");
    expect(text).toContain("Brief: Guard the empty list in the key handler");
    expect(text).toContain("Criteria:\n- no panic on j\n- list stays selected");
    expect(text).toContain("1. guard j (~12 LOC; touches board/src/keys.rs): no panic on j");
    expect(text).toContain("Rollback: Revert the commit; nothing else changes.");
    expect(text).toContain("Scenarios:\n- no panic on j\n  - j on empty: cargo test keys::empty");
    expect(text).toContain("No scenario names these criteria:\n- list stays selected");
  });

  it("renders the code map when the plan has one, and says nothing when it has none", () => {
    expect(renderPlan(plan as never)).not.toContain("Code map");
    const withMap = renderPlan({ ...plan, map: { components: ["board keys"], files: ["board/src/keys.rs", "board/src/app.rs"], owners: ["@marta"], confidence: 0.8, note: "no tests found" } } as never);
    expect(withMap).toContain("Code map (confidence 0.8):\n- components: board keys\n- files: board/src/keys.rs, board/src/app.rs\n- owners: @marta\n- note: no tests found");
    expect(renderPlan({ ...plan, map: null } as never)).not.toContain("Code map");
  });

  it("is the state a decision sees, ahead of the questions", () => {
    const state = stateOf(input);
    expect(state.title).toBe("Guard the empty list in the key handler");
    const text = renderDecision(PACKS.plan_check.questions, state);
    expect(text.indexOf("Brief: Guard the empty list")).toBeGreaterThan(-1);
    expect(text.indexOf("Brief:")).toBeLessThan(text.indexOf("# Questions"));
    expect(text).toContain("## fits_record (score)");
  });
});

describe("a check context", () => {
  const base = { schema: 3, stage: "red_check", pack: "red_check", attempt: 1, task: { id: "t", title: "t", description: "", criteria: [], repoPath: "", branch: "", source: null }, plan: null, decisions: [], priorFindings: [], limits: { maxTurns: 1, timeoutMs: 1 }, env: {} };

  it("renders a red's slice, acceptance and failing output", () => {
    const check = { kind: "red", slice: { id: 2, title: "Export endpoint", acceptance: ["returns csv", "404 on unknown id"] }, output: "AssertionError: expected 404" };
    const state = stateOf({ ...base, context: { projectContext: null, check } } as never);
    expect(state.title).toBe("Red check: slice 2, Export endpoint");
    expect(state.description).toContain("- returns csv");
    expect(state.description).toContain("AssertionError: expected 404");
    expect(renderCheck(check as never)).toBe(state.description);
  });

  it("renders a scope's planned, changed, undeclared, declared, removed, dependency, TODO and secret facts", () => {
    const check = { kind: "scope", planned: ["a.ts"], changed: ["a.ts", "b.ts"], undeclared: ["b.ts"], declared: [{ path: "c.ts", reason: "shared helper" }], removedTests: ["a.test.ts"], newDependencies: ["left-pad"], todos: ["a.ts: TODO fix"], secrets: [".env"], diffSummary: "two files" };
    const text = stateOf({ ...base, context: { projectContext: null, check } } as never).description;
    for (const part of ["Planned files:\n- a.ts", "Changed files:\n- a.ts\n- b.ts", "Not planned and not declared:\n- b.ts", "- c.ts: shared helper", "Removed tests:\n- a.test.ts", "New dependencies:\n- left-pad", "Added TODOs:\n- a.ts: TODO fix", "Secret-looking additions:\n- .env", "Summary: two files"]) expect(text).toContain(part);
  });
});

describe("a finding and an e2e check context", () => {
  const base = { schema: 3, stage: "finding_classify", pack: "finding_classify", attempt: 1, task: { id: "t", title: "t", description: "", criteria: [], repoPath: "", branch: "", source: null }, plan: null, decisions: [], priorFindings: [], limits: { maxTurns: 1, timeoutMs: 1 }, env: {} };

  it("renders a finding with its location and the excerpt", () => {
    const check = { kind: "finding", finding: { path: "src/a.ts", line: 3, severity: "bug", title: "off by one", body: "loops past the end", confidence: 0.8 }, excerpt: "for (let i = 0; i <= n; i++) {}" };
    const state = stateOf({ ...base, context: { projectContext: null, check } } as never);
    expect(state.title).toBe("Finding: off by one");
    expect(state.description).toContain("Finding (bug, confidence 0.8): off by one");
    expect(state.description).toContain("src/a.ts:3");
    expect(state.description).toContain("Excerpt:\nfor (let i = 0; i <= n; i++) {}");
  });

  it("renders an e2e failure's attempt, summary and each row that did not pass", () => {
    const check = { kind: "e2e", e2e: { verdict: "fail", summary: "the page never loaded", attempt: 2, criteria: [{ text: "login works", result: "fail", note: "timeout" }, { text: "logout works", result: "pass" }, { text: "reset works", result: "partial" }] } };
    const state = stateOf({ ...base, context: { projectContext: null, check } } as never);
    expect(state.title).toBe("E2E failure: attempt 2");
    expect(state.description).toContain("Attempt 2, verdict fail");
    expect(state.description).toContain("the page never loaded");
    expect(state.description).toContain("- login works: fail (timeout)");
    expect(state.description).toContain("- reset works: partial");
    expect(state.description).not.toContain("logout works");
  });
});

describe("decisionSummary", () => {
  it("is one line per question with its confidence, and names the ones below the pack's bar", () => {
    const answer = { kind: { choice: "bug", confidence: 0.91 }, area: { choice: "board", confidence: 0.62 }, ready: { value: true, p: 0.83 }, size: { score: 1.4, confidence: 0.75 } };
    expect(decisionSummary(questions, answer, 0.7)).toBe("kind bug (0.91) · area board (0.62) · ready yes (p 0.83) · size 1.4 (0.75) · below 0.7: area");
  });
});
