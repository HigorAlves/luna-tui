import { PACKS, type StageInput } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import { decisionSummary, renderCheck, renderDecision, renderEvidence, renderPlan, renderShip, stateOf } from "./decide.ts";

const questions = PACKS.triage_signals.questions;

describe("renderDecision", () => {
  it("puts the state first, then every question with its type and labels, then the answer rule", () => {
    const text = renderDecision(questions, { title: "Board panics on key", description: "Pressing j on an empty list panics." });
    expect(text).toContain("# State\n");
    expect(text).toContain("Board panics on key");
    expect(text).toContain("## kind (choice)");
    expect(text).toContain("- bug: Something that works, or should work, is broken");
    expect(text).toContain("## ready (yes or no)");
    expect(text).toContain("## size (choice)");
    expect(text).toContain("- XS:");
    expect(text).toContain("## who (score)");
    expect(text).toContain("- 0 few:");
    expect(text).toMatch(/Answer only with the JSON object the schema asks for/);
    expect(text).toMatch(/confidence/);
  });
});

describe("coverage_check's state", () => {
  const plan = {
    record: null, brief: "", assumptions: [], slices: [],
    criteria: ["A coupon applies once", "An expired coupon is refused", "The page has a title"],
    cases: [
      { id: "S1", title: "once", criterion: "A coupon applies once", criterion_ref: "C1", type: "happy", given: "a cart", when: "applied twice", then: "it counts once", approach: "x" },
      { title: "v1 case", criterion: "An expired coupon is refused", approach: "apply an expired coupon and read the error" },
    ],
    // What the planner and the code map said never reaches it, even when a caller sends it.
    map: { components: ["SECRET MAP"], files: [], entry_points: [], owners: [], confidence: 0.5 },
  };
  const state = (over: Record<string, unknown> = {}) => stateOf({ pack: "coverage_check", task: { title: "T", description: "D" }, context: { plan: { ...plan, ...over } } } as unknown as StageInput);

  it("lists the criteria with their ids and each scenario with the criterion it names, as given/when/then (a v1 case by its approach)", () => {
    const { description } = state();
    expect(description).toContain("Criteria:\nC1: A coupon applies once\nC2: An expired coupon is refused\nC3: The page has a title");
    expect(description).toContain("S1 [happy] -> C1: given a cart, when applied twice, then it counts once");
    expect(description).toContain("(no id) [happy] -> C2: apply an expired coupon and read the error");
    expect(description).not.toMatch(/SECRET MAP|Code map|Slices|Brief/);
  });

  it("says nothing names a criterion by its id, and the scenarios when there are none", () => {
    expect(state().description).toContain("No scenario names: C3");
    expect(state({ cases: [] }).description).toContain("Scenarios:\n(none)");
  });

  it("leaves every other pack's state as it was", () => {
    const other = stateOf({ pack: "plan_check", task: { title: "T", description: "D" }, context: { plan: { ...plan, brief: "B" } } } as unknown as StageInput);
    expect(other.description).toContain("Brief: B");
  });
});

describe("stateOf", () => {
  it("prefers context.issue and falls back to the task's title and description", () => {
    const base = { task: { title: "T", description: "D" }, context: {} } as unknown as StageInput;
    expect(stateOf(base)).toEqual({ title: "T", description: "D" });
    expect(stateOf({ ...base, context: { issue: { title: "I", description: "E" } } } as unknown as StageInput)).toEqual({ title: "I", description: "E" });
    const answered = { ...base, context: { issue: { title: "I", description: "E", answers: [{ question: "Which OS?", answer: "macOS" }] } } } as unknown as StageInput;
    expect(stateOf(answered)).toEqual({ title: "I", description: "E\n\nAnswers so far:\n- Which OS?: macOS" });
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
    const withMap = renderPlan({ ...plan, map: { components: ["board keys"], files: [{ path: "board/src/keys.rs", role: "change" }, { path: "board/src/app.rs", role: "read" }], entry_points: ["keys::handle"], owners: ["@marta"], confidence: 0.8, note: "no tests found" } } as never);
    expect(withMap).toContain("Code map (confidence 0.8):\n- components: board keys\n- files: board/src/keys.rs (change), board/src/app.rs (read)\n- entry points: keys::handle\n- owners: @marta\n- note: no tests found");
    const stale = renderPlan({ ...plan, map: { components: [], files: [], entry_points: [], owners: [], confidence: 0.4, stale: true, behind: 120 } } as never);
    expect(stale).toContain("Code map (confidence 0.4, stale: 120 commits behind):");
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
    const answer = { kind: { choice: "bug", confidence: 0.91 }, type_of_work: { choice: "backend", confidence: 0.62 }, ready: { value: true, p: 0.83 }, size: { choice: "S", confidence: 0.75 }, who: { score: 1.4, confidence: 0.65 } };
    expect(decisionSummary(questions, answer, 0.7)).toBe("kind bug (0.91) · type_of_work backend (0.62) · ready yes (p 0.83) · size S (0.75) · who 1.4 (0.65) · below 0.7: type_of_work, who");
  });
});

describe("an evidence context", () => {
  const base = { schema: 3, stage: "evidence_format", pack: "evidence_format", attempt: 1, task: { id: "t", title: "Evidence format", description: "", criteria: [], repoPath: "", branch: "", source: null }, plan: null, decisions: [], priorFindings: [], limits: { maxTurns: 1, timeoutMs: 1 }, env: {} };
  const record = { source: "github", kind: "feature", area: "board", goal: "Show the cart total", size: "small", urgency: "normal", risk: "low", signals: { area: { answer: "web", confidence: 0.9 } }, qa: [], decision: "plan", reason: "r", at: "2026-11-04T00:00:00.000Z", model: "m" };
  const evidence = { record, risk: "medium", webSurface: true, e2e: { ran: true, verdict: "pass", hasVideo: true, hasSteps: true, scenarios: 3, skippedReason: null }, videoImage: false, changed: ["web/cart.tsx", "web/cart.css"] };

  it("renders the goal, risk, surface, the browser run, the video image and the changed paths", () => {
    const text = renderEvidence(evidence as never);
    for (const part of ["Goal: Show the cart total", "Record: feature", "Risk: medium", "Web surface: yes", "E2E: ran, verdict pass, 3 scenarios, a recording, replayable steps", "Video image: absent", "Changed files:\n- web/cart.tsx\n- web/cart.css"]) expect(text).toContain(part);
  });

  it("says why e2e did not run and that there is no surface", () => {
    const text = renderEvidence({ record: null, risk: null, webSurface: false, e2e: { ran: false, verdict: null, hasVideo: false, hasSteps: false, scenarios: 0, skippedReason: "no web surface" }, videoImage: true } as never);
    expect(text).toContain("Web surface: no");
    expect(text).toContain("E2E: did not run (no web surface)");
    expect(text).toContain("Video image: present");
    expect(text).not.toContain("Goal:");
  });

  it("is the state a decision sees, titled by the goal", () => {
    const state = stateOf({ ...base, context: { projectContext: null, evidence } } as never);
    expect(state.title).toBe("Evidence format: Show the cart total");
    expect(state.description).toBe(renderEvidence(evidence as never));
    expect(renderDecision(PACKS.evidence_format.questions, state)).toContain("## format (choice)");
  });
});

describe("a ship context", () => {
  const base = { schema: 3, stage: "event_class", pack: "event_class", attempt: 1, task: { id: "t", title: "Ship", description: "", criteria: [], repoPath: "", branch: "", source: null }, plan: null, decisions: [], priorFindings: [], limits: { maxTurns: 1, timeoutMs: 1 }, env: {} };
  const state = (ship: unknown) => stateOf({ ...base, context: { projectContext: null, ship } } as never);

  it("titles and renders an event: who, what kind, the body", () => {
    const ship = { kind: "event", event: { actor: "ana", isBot: false, isMe: false, kind: "review", state: "CHANGES_REQUESTED", body: "please rename it", url: "https://x/1" } };
    expect(state(ship).title).toBe("PR event: ana review");
    for (const part of ["Actor: ana", "Kind: review (CHANGES_REQUESTED)", "URL: https://x/1", "please rename it"]) expect(state(ship).description).toContain(part);
    expect(renderDecision(PACKS.event_class.questions, state(ship))).toContain("## event (choice)");
  });

  it("titles a comment by its path, with the thread and the pack", () => {
    const ship = { kind: "comment", comment: { thread: { id: "T1", path: "a.ts", line: 4, comments: [{ author: "ana", body: "why?", at: "t" }] }, pack: { summary: "Adds x", scenarios: [{ text: "x works", result: "pass" }], howToVerify: "run it" }, myReplies: 1 } };
    expect(state(ship).title).toBe("Comment on a.ts");
    for (const part of ["Thread T1 at a.ts:4", "@ana (t): why?", "Pack summary: Adds x", "- x works: pass", "How to verify: run it", "Replies already posted here: 1"]) expect(state(ship).description).toContain(part);
    expect(state({ ...ship, comment: { ...ship.comment, thread: { ...ship.comment.thread, path: null } } }).title).toBe("Comment on the PR");
  });

  it("titles a fix by its thread and a retro by the task", () => {
    const fix = { kind: "fix", fix: { changed: ["a.ts"], diffSummary: "+3 -1", scenarios: [], threadSummary: "rename x" } };
    expect(state(fix).title).toBe("Fix: rename x");
    expect(state(fix).description).toContain("Changed files:\n- a.ts");
    const retro = { kind: "retro", retro: { predicted: { size: "small", risk: "low", estLoc: 80 }, actual: { added: 200, removed: 10, retries: { verify: 1, e2e: 0, ci: 0, total: 1 }, escalations: 1, format: "captures", durationMin: 42 }, runs: 9 } };
    expect(state(retro).title).toBe("Retro: Ship");
    expect(renderShip(retro as never)).toContain("Predicted: size small, risk low, 80 LOC");
    expect(renderShip(retro as never)).toContain("Actual: +200 -10 LOC, retries 1 (verify 1, e2e 0, ci 0), 1 escalation, format captures, 42 min");
  });
});
