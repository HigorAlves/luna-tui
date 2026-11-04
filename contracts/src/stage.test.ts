import { describe, expect, it } from "vitest";

import {
  AGENT_PACKS,
  AgentRole,
  ArtifactKind,
  ChatTriageAnswer,
  ChatTriageContext,
  CloneInput,
  EscalationReason,
  EvidenceContext,
  VideoContext,
  EvidencePack,
  EvalJudgeAnswer,
  CodeMapAnswer,
  PlanAnswer,
  PlanContext,
  TestDesignAnswer,
  EvalJudgeContext,
  JiraIntakeContext,
  TaskClassification,
  COLUMN_OF,
  MergeInput,
  NO_ACCESS,
  PACKS,
  PackId,
  PrAction,
  PrAddressAnswer,
  PrReviewAnswer,
  PrSplit,
  ReviewContext,
  RUNNING,
  SlackTriageAnswer,
  SlackTriageContext,
  StageInput,
  StageOutput,
  TaskRoute,
  TaskSource,
  TaskState,
  TestCase,
  TriageRecord,
  ThreadsContext,
  VerifyResult,
  resolveEngine,
} from "./index.ts";

// The two examples are the contract's own: what the machine writes and what a runner answers.
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
  env: { LUNA_FACTORY: "1" },
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

describe("TestCase", () => {
  it("parses {title, criterion, approach}, criterion nullable", () => {
    expect(TestCase.safeParse({ title: "t", criterion: "c", approach: "a" }).success).toBe(true);
    expect(TestCase.safeParse({ title: "t", criterion: null, approach: "a" }).success).toBe(true);
  });

  it("rejects the old test field in its place", () => {
    expect(TestCase.safeParse({ title: "t", criterion: "c", test: "a.test.ts > x" }).success).toBe(false);
  });
});

describe("VerifyResult", () => {
  it("extends TestCase with a pass/fail outcome", () => {
    const parsed = VerifyResult.safeParse({ title: "t", criterion: "c", approach: "a", outcome: "fail" });
    expect(parsed.success).toBe(true);
    expect(VerifyResult.safeParse({ title: "t", criterion: null, approach: "a", outcome: "maybe" }).success).toBe(false);
  });
});

describe("StageInput", () => {
  it("reads schema 3 testCases with approach, and still reads schema 2's test field for old images", () => {
    const base = { ...stageInputExample, schema: 3 as const };
    const v3 = StageInput.safeParse({ ...base, context: { ...base.context, testCases: [{ title: "t", criterion: "c", approach: "a" }] } });
    expect(v3.success).toBe(true);
    const legacy = StageInput.safeParse({
      ...stageInputExample,
      schema: 2,
      context: { ...stageInputExample.context, testCases: [{ title: "t", criterion: "c", test: "a.test.ts > x" }] },
    });
    expect(legacy.success).toBe(true);
    expect(StageInput.safeParse({ ...stageInputExample, schema: 4 }).success).toBe(false);
  });

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
  // What a pack actually answers (the registry's schemas), not what the example happens to show.
  it("accepts a finding exactly as the verifying/ci_watch answer schema shapes it: no start_line, no suggestion_code", () => {
    const finding = { path: "src/a.ts", line: 7, severity: "bug", title: "off by one", body: "b", confidence: 0.9 };
    expect(StageOutput.safeParse({ ...stageOutputExample, findings: [finding] }).success).toBe(true);
  });

  it("accepts resetsAt as the string run.mjs writes, and as a number", () => {
    expect(StageOutput.safeParse({ ...stageOutputExample, rateLimited: true, resetsAt: "1761300000" }).success).toBe(true);
    expect(StageOutput.safeParse({ ...stageOutputExample, rateLimited: true, resetsAt: 1761300000 }).success).toBe(true);
  });

  it("accepts what the run ran on and its fingerprint, and a result from a runner that wrote none", () => {
    const run = { runtime: "claude", engine: "claude:sonnet", modelId: "claude-sonnet-5-5", sdk: { name: "@anthropic-ai/claude-agent-sdk", version: "0.3.311" }, fingerprint: "a".repeat(64) };
    expect(StageOutput.parse({ ...stageOutputExample, run }).run).toEqual(run);
    expect(StageOutput.safeParse({ ...stageOutputExample, run: null }).success).toBe(true);
    expect(StageOutput.safeParse({ ...stageOutputExample, run: { ...run, fingerprint: "short" } }).success).toBe(false);
  });

  it("accepts a question with no recommended answer, and an object error", () => {
    expect(StageOutput.safeParse({ ...stageOutputExample, outcome: "needs_input", needsInput: [{ question: "which db?", recommended: null }] }).success).toBe(true);
    expect(StageOutput.safeParse({ ...stageOutputExample, ok: false, outcome: "fail", error: { code: "E", message: "boom" } }).success).toBe(true);
  });

  it("parses the contract example", () => {
    expect(StageOutput.safeParse(stageOutputExample).success).toBe(true);
  });

  it("parses with and without the optional answer", () => {
    expect(StageOutput.safeParse({ ...stageOutputExample, answer: { kind: "done", criteria: ["a"] } }).success).toBe(true);
    expect(StageOutput.safeParse({ ...stageOutputExample, answer: null }).success).toBe(true);
    expect(StageOutput.safeParse(stageOutputExample).success).toBe(true);
    expect(StageOutput.safeParse({ ...stageOutputExample, answer: "text" }).success).toBe(false);
  });

  it("reads schema 3 (ledger, session), 2 (escalated) and 1, and refuses anything newer", () => {
    expect(StageOutput.safeParse({ ...stageOutputExample, schema: 2, outcome: "escalated" }).success).toBe(true);
    expect(StageOutput.safeParse({ ...stageOutputExample, schema: 2 }).success).toBe(true);
    expect(StageOutput.safeParse({ ...stageOutputExample, schema: 1, outcome: "escalated" }).success).toBe(false);
    expect(StageOutput.safeParse({ ...stageOutputExample, schema: 3 }).success).toBe(true);
    expect(StageOutput.safeParse({ ...stageOutputExample, schema: 4 }).success).toBe(false);
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
  it("has the eleven stage packs, each named after a task state, plus the Slack, chat and Jira intake triages, the issue classifier and the eval judge", () => {
    expect([...PackId.options].sort()).toEqual(
      ["setup", "triage", "test_design", "plan", "plan_fast", "test_design_fast", "implementing", "verifying", "e2e", "evidence", "ci_watch", "reviewing_memory", "reviewing", "addressing", "slack_triage", "jira_intake", "triage_signals", "risk_score", "coverage_check", "plan_check", "eval_judge", "chat_triage", "code_map", "red_check", "scope_check", "finding_classify", "e2e_failure_cause", "evidence_format", "video_script", "recording", "video_qa", "video_fix"].sort(),
    );
    const onDemand: string[] = ["slack_triage", "jira_intake", "triage_signals", "risk_score", "coverage_check", "plan_check", "eval_judge", "chat_triage", "red_check", "scope_check", "finding_classify", "e2e_failure_cause", "evidence_format"];
    // The planner runs in the test_design state (the machine's RUNS_IN), so it names no state of its own.
    const runsInAnotherState: string[] = ["plan", "plan_fast", "test_design_fast", "code_map", "video_script", "recording", "video_qa", "video_fix"];
    for (const pack of PackId.options) {
      if (onDemand.includes(pack) || runsInAnotherState.includes(pack)) expect(TaskState.options).not.toContain(pack);
      else expect(TaskState.options).toContain(pack);
    }
  });
});

describe("the plan pack", () => {
  it("is the planner on opus, read-only with the web and the decision tool, 30 turns, answering a plan", () => {
    expect(PACKS.plan).toMatchObject({
      kind: "agent", agent: "planner", helpers: [], skills: ["writing-plans", "code-discovery"], writable: false, maxTurns: 30, effort: "high", template: "plan.md",
      engines: { default: "claude:opus", allowed: ["claude:opus", "codex:sol"], fallback: ["codex:sol", "claude:opus"] },
    });
    expect(PACKS.plan.kind === "agent" && PACKS.plan.access).toMatchObject({ read: true, web: true, write: false, luna: expect.arrayContaining(["decision_get"]) });
  });

  it("has a fast lane: the same plan and scenarios on sonnet at low effort, 15 turns, for a small low-risk ticket", () => {
    expect(PACKS.plan_fast).toMatchObject({ kind: "agent", agent: "fast-planner", helpers: [], writable: false, maxTurns: 15, effort: "low", template: "plan_fast.md", answer: PlanAnswer, engines: { default: "claude:sonnet", allowed: ["claude:sonnet"] } });
    expect(PACKS.test_design_fast).toMatchObject({ kind: "agent", agent: "test-designer", helpers: [], writable: false, maxTurns: 15, effort: "low", template: "test_design.md", answer: TestDesignAnswer, engines: { default: "claude:sonnet", allowed: ["claude:sonnet"] } });
    expect(PlanAnswer.safeParse({ kind: "needs_full_plan", summary: "a second component appears" }).success).toBe(true);
  });

  it("answers done with the plan, or questions", () => {
    const slice = { title: "s", est_loc: 10, touchpoints: ["a.ts"], acceptance: ["ok"] };
    const plan = { kind: "done", summary: "s", brief: "b", criteria: ["c"], assumptions: ["a"], slices: [slice], rollback: "revert the commit" };
    expect(PlanAnswer.parse(plan)).toEqual(plan);
    expect(PlanAnswer.safeParse({ kind: "questions", summary: "s", questions: [{ question: "q", recommended: "r" }] }).success).toBe(true);
    expect(PlanAnswer.safeParse({ ...plan, kind: "maybe" }).success).toBe(false);
  });
});

describe("the code_map pack", () => {
  it("is the code-mapper on haiku at low effort, 8 turns, read-only with the graph's verbs, git shortlog and git log", () => {
    expect(PACKS.code_map).toMatchObject({
      kind: "agent", agent: "code-mapper", helpers: [], writable: false, maxTurns: 8, effort: "low", template: "code_map.md", answer: CodeMapAnswer,
      engines: { default: "claude:haiku", allowed: ["claude:haiku"] },
    });
    const access = PACKS.code_map.kind === "agent" ? PACKS.code_map.access : null;
    expect(access).toMatchObject({ read: true, write: false, web: false });
    expect(access?.commands).toEqual(expect.arrayContaining(["graphify query", "graphify affected", "graphify god-nodes", "git shortlog", "git log"]));
  });

  it("answers components, files, owners and a confidence, with an optional note", () => {
    const map = { components: ["board keys"], files: ["board/src/keys.rs"], owners: ["@marta"], confidence: 0.8 };
    expect(CodeMapAnswer.parse({ ...map, note: "no tests found" })).toEqual({ ...map, note: "no tests found" });
    expect(CodeMapAnswer.safeParse({ ...map, confidence: 1.4 }).success).toBe(false);
    expect(CodeMapAnswer.safeParse({ components: [], files: [] }).success).toBe(false);
  });

  it("rides on a plan context as an optional map", () => {
    const plan = { record: null, brief: "b", criteria: [], assumptions: [], slices: [] };
    const map = { components: ["c"], files: ["a.ts"], owners: [], confidence: 0.5 };
    expect(PlanContext.parse({ ...plan, map })).toEqual({ ...plan, map });
    expect(PlanContext.parse({ ...plan, map: null }).map).toBeNull();
    expect(PlanContext.parse(plan).map).toBeUndefined();
  });
});

describe("eval_judge", () => {
  it("runs as the eval-judge on opus only, no tools and no worktree, and answers a score, a pass and the reasons", () => {
    expect(PACKS.eval_judge).toMatchObject({ agent: "eval-judge", helpers: [], skills: [], access: NO_ACCESS, writable: false, maxTurns: 3, engines: { default: "claude:opus", allowed: ["claude:opus"] }, template: "eval_judge.md" });
    expect(EvalJudgeAnswer.safeParse({ score: 0.8, pass: true, reasons: ["item m2: right priority"] }).success).toBe(true);
    expect(EvalJudgeAnswer.safeParse({ score: 1.2, pass: true, reasons: [] }).success).toBe(false);
  });

  it("reads the case from the stage input's context", () => {
    const judged = { pack: "slack_triage", caseId: "incident", rubric: "P0 for the outage", input: "{}", checks: "[]", answer: "{}" };
    expect(EvalJudgeContext.safeParse(judged).success).toBe(true);
    expect(EvalJudgeContext.safeParse({ ...judged, pack: "nope" }).success).toBe(false);
  });
});

describe("slack_triage", () => {
  it("runs as the slack-triager on haiku (Codex luna allowed), low effort, three turns, no tools and no worktree", () => {
    expect(PACKS.slack_triage).toMatchObject({ agent: "slack-triager", helpers: [], skills: [], access: NO_ACCESS, writable: false, maxTurns: 3, engines: { default: "claude:haiku", allowed: ["claude:haiku", "codex:luna"], fallback: ["codex:luna", "claude:haiku"] }, effort: "low", template: "slack_triage.md" });
    expect(PACKS.slack_triage.timeoutMs).toBe(3 * 60_000);
    expect(AgentRole.options).toContain("slack-triager");
  });

  it("answers one verdict per item id, and a stage input may carry the inbox batch", () => {
    const verdict = { id: "C1:1", priority: "P1", category: "question", expectsReply: true, summary: "s", why: "w", draft: "d", refs: [{ kind: "pr", ref: "o/a#1" }], deadline: null };
    expect(SlackTriageAnswer.safeParse({ items: [verdict] }).success).toBe(true);
    expect(SlackTriageAnswer.safeParse({ items: [{ ...verdict, priority: "P9" }] }).success).toBe(false);
    const slack = {
      me: { id: "U1", name: "higor" },
      watches: [{ label: "@platform-team", kind: "usergroup" }],
      rules: "## Notes\n- short replies",
      items: [{ id: "C1:1", channel: "#eng", author: "@marta", isBot: false, text: "can you?", context: [{ user: "@lee", text: "earlier" }], matched: ["me"], threadReplies: 1 }],
    };
    expect(SlackTriageContext.safeParse(slack).success).toBe(true);
    expect(StageInput.safeParse({ ...stageInputExample, pack: "slack_triage", context: { projectContext: null, slack } }).success).toBe(true);
  });
});

describe("chat_triage", () => {
  const teams = {
    source: "teams",
    me: { id: "8f2c", name: "Higor Alves" },
    items: [
      { id: "chat:19:abc", place: "Rafa Souza", kind: "dm", author: "Rafa Souza", isBot: false, text: "can you approve the rollout today?", context: [{ author: "Rafa Souza", text: "staging is green" }], matched: ["dm"], replies: 0, flag: "urgent", floor: "P0" },
      { id: "post:t1:c1:m1", place: "Platform › incidents", kind: "channel", author: "Azure DevOps", isBot: true, text: "build 4411 failed", matched: ["watch"], replies: 2, flag: null },
    ],
  };

  it("runs as the chat-triager like slack_triage: haiku (Codex luna allowed), low effort, three turns, no tools, no worktree", () => {
    expect(PACKS.chat_triage).toMatchObject({ agent: "chat-triager", helpers: [], skills: [], access: NO_ACCESS, writable: false, maxTurns: 3, timeoutMs: 3 * 60_000, engines: { default: "claude:haiku", allowed: ["claude:haiku", "codex:luna"], fallback: ["codex:luna", "claude:haiku"] }, effort: "low", template: "chat_triage.md" });
    expect(AgentRole.options).toContain("chat-triager");
  });

  it("answers in slack_triage's shape, so one schema serves Slack and Teams", () => {
    expect(ChatTriageAnswer).toBe(SlackTriageAnswer);
    expect(PACKS.chat_triage.answer).toBe(SlackTriageAnswer);
  });

  it("takes a Teams batch and a Slack batch in one context shape, and a stage input may carry it", () => {
    expect(ChatTriageContext.safeParse(teams).error).toBeUndefined();
    const slack = { source: "slack", me: { id: "U1", name: "higor" }, rules: "## VIPs\n- @cto", items: [{ id: "C1:1700.1", place: "#eng", kind: "channel", author: "@marta", isBot: false, text: "review?", matched: ["me"] }] };
    expect(ChatTriageContext.safeParse(slack).error).toBeUndefined();
    expect(StageInput.safeParse({ ...stageInputExample, pack: "chat_triage", context: { projectContext: null, chat: teams } }).error).toBeUndefined();
  });

  it("refuses an empty batch, more than 25 items, an unknown source or place kind", () => {
    expect(ChatTriageContext.safeParse({ ...teams, items: [] }).success).toBe(false);
    expect(ChatTriageContext.safeParse({ ...teams, items: Array.from({ length: 26 }, (_, i) => ({ ...teams.items[1], id: `i${i}` })) }).success).toBe(false);
    expect(ChatTriageContext.safeParse({ ...teams, source: "discord" }).success).toBe(false);
    expect(ChatTriageContext.safeParse({ ...teams, items: [{ ...teams.items[0], kind: "oneOnOne" }] }).success).toBe(false);
  });
});

describe("TaskClassification", () => {
  const classification = { kind: "question", area: "machine", ready: false, size: 0.2, confidence: 0.85, at: "2026-11-03T12:00:00.000Z", model: "typesafe-ai/jev" };
  const jira = { key: "HAR-1", url: "u", summary: "s", description: "", issueType: null, priority: null, labels: [], dueAt: null, comments: [], repoPath: null };

  it("is what intake stores, with a confidence between 0 and 1", () => {
    expect(TaskClassification.parse(classification)).toEqual(classification);
    expect(TaskClassification.safeParse({ ...classification, confidence: 1.2 }).success).toBe(false);
  });

  it("rides jira_intake's context as a hint, and its absence changes nothing", () => {
    expect(JiraIntakeContext.parse({ ...jira, classification }).classification).toEqual(classification);
    expect(JiraIntakeContext.parse(jira).classification).toBeUndefined();
  });
});

describe("ArtifactKind", () => {
  it("lists the eleven kinds, audio and captions among them", () => {
    expect(ArtifactKind.options).toHaveLength(11);
    expect(ArtifactKind.options).toEqual(expect.arrayContaining(["audio", "captions"]));
  });
});

describe("PR tasks", () => {
  it("a PR source carries its head and base; an issue source is unchanged", () => {
    const pr = TaskSource.parse({ kind: "github_pr", repo: "a/b", number: 7, url: "u", headRef: "feat/x", baseRef: "main" });
    expect(pr.kind).toBe("github_pr");
    expect(() => TaskSource.parse({ kind: "github_pr", repo: "a/b", number: 7, url: "u" })).toThrow();
    expect(TaskSource.parse({ kind: "github", repo: "a/b", number: 7, url: "u" }).kind).toBe("github");
  });

  it("a notch source names the notch ticket, and its Jira key only when it has one", () => {
    const notch = TaskSource.parse({ kind: "notch", ref: "LUNA-14", id: "t-1", jiraKey: "PLAT-123" });
    expect(notch).toEqual({ kind: "notch", ref: "LUNA-14", id: "t-1", jiraKey: "PLAT-123" });
    expect(TaskSource.parse({ kind: "notch", ref: "LUNA-14", id: "t-1", jiraKey: null }).kind).toBe("notch");
    // A work order with no ticket to name is not a notch task: the notch always sends both.
    expect(TaskSource.safeParse({ kind: "notch", ref: "", id: "t-1" }).success).toBe(false);
    expect(TaskSource.safeParse({ kind: "notch", ref: "LUNA-14", id: "" }).success).toBe(false);
    expect(TaskSource.parse({ kind: "notch", ref: "LUNA-14", id: "t-1" }).kind).toBe("notch");
    expect(() => TaskSource.parse({ kind: "notch", ref: "LUNA-14" })).toThrow();
  });

  it("routes are a closed set: feature is today's pipeline, setup only proposes luna.yaml, the rest are PR actions", () => {
    expect(TaskRoute.options).toEqual(["feature", "setup", "ci_fix", "review", "address"]);
    expect(PrAction.options).toEqual(["ci_fix", "review", "address"]);
  });

  it("review and address answers have the shape the host posts from", () => {
    const review = PrReviewAnswer.parse({ verdict: "comment", summary: "s", findings: [], comments: [{ path: "a.ts", line: 3, body: "nit" }] });
    expect(review.comments[0]?.side).toBe("RIGHT");
    const address = PrAddressAnswer.parse({ kind: "done", summary: "s", replies: [{ threadId: "T1", body: "fixed", resolve: true }] });
    expect(address.replies).toHaveLength(1);
    expect(() => PrReviewAnswer.parse({ verdict: "maybe", summary: "s", findings: [], comments: [] })).toThrow();
  });

  it("a stage input may carry a review or a threads context", () => {
    const review = { pr: { repo: "a/b", number: 1, url: "u", title: "t", body: null, author: "x", baseRef: "main", headRef: "f" }, diff: "", files: [], existingComments: [] };
    expect(ReviewContext.safeParse(review).success).toBe(true);
    expect(ThreadsContext.safeParse({ pr: review.pr, threads: [{ id: "T", path: "a.ts", line: 1, comments: [{ author: "r", body: "b", at: "2026-10-27T00:00:00Z" }] }] }).success).toBe(true);
    expect(StageInput.safeParse({ ...stageInputExample, pack: "reviewing", context: { projectContext: null, review } }).success).toBe(true);
  });

  it("the new states sit in Build and Verify and count as running", () => {
    expect(COLUMN_OF.reviewing).toBe("Verify");
    expect(COLUMN_OF.addressing).toBe("Build");
    expect(RUNNING.has("reviewing")).toBe(true);
    expect(RUNNING.has("addressing")).toBe(true);
  });

  it("the PR packs run as the orc roles with their helpers: a security pass for reviewing, a reply drafter for addressing", () => {
    expect(PACKS.reviewing).toMatchObject({ agent: "pr-reviewer", helpers: [{ role: "security-reviewer", engine: "claude:opus" }] });
    expect(PACKS.reviewing.skills).toEqual(expect.arrayContaining(["inline-review", "review-contract", "caveman-review"]));
    expect(PACKS.addressing).toMatchObject({ agent: "code-fixer", helpers: [{ role: "reply-drafter", engine: "claude:haiku" }] });
    expect(PACKS.addressing.skills).toEqual(expect.arrayContaining(["receiving-code-review", "verification-before-completion"]));
    for (const pack of AGENT_PACKS) {
      expect(Array.isArray(pack.helpers), pack.id).toBe(true);
      // A role with subagent helpers (on Claude, beside a Claude default) needs the Agent tool to
      // dispatch them; one without must not carry it. A helper on another runtime is `delegate`'s.
      const subagents = pack.helpers.filter((h) => resolveEngine(h.engine).runtime === "claude" && resolveEngine(pack.engines.default).runtime === "claude");
      expect(pack.access.agent, pack.id).toBe(subagents.length > 0);
    }
    expect(AgentRole.options).toEqual(expect.arrayContaining(["security-reviewer", "reply-drafter", "code-fixer"]));
  });

  it("a PR splits into one of six places and the snapshot shape parses", () => {
    expect(PrSplit.options).toEqual(["review_requested", "ready_to_merge", "ci_failed", "ci_running", "changes_requested", "mine"]);
    expect(CloneInput.safeParse({ repo: "owner/name", dest: "/x" }).success).toBe(true);
    expect(CloneInput.safeParse({ repo: "owner", dest: "/x" }).success).toBe(false);
    expect(MergeInput.parse({}).method).toBe("squash");
  });
});

describe("TriageRecord and EvidencePack", () => {
  const record = { source: "github", kind: "bug", goal: "Pressing j on an empty list must not panic", size: "small", urgency: "normal", risk: "low",
    signals: { kind: { answer: "bug", confidence: 0.91 } }, qa: [], decision: "plan", reason: "clear repro, one file", at: "2026-11-03T12:00:00.000Z", model: "typesafe/jev" };
  const evidence = { summary: "The list no longer panics", format: "captures", scenarios: [{ text: "j on an empty list keeps the board up", test: "board::tests::empty_list_j", result: "pass" }],
    findings: [], outOfMap: [], risk: "low", rollback: "revert the commit", howToVerify: "cargo test empty_list_j", commitSha: "8cb5509", media: [{ kind: "screenshot", label: "after", url: "evidence/1/8cb5509/after.png" }], at: "2026-11-03T12:00:00.000Z" };
  it("round-trip, and refuse a risk off the scale", () => {
    expect(TriageRecord.parse(record)).toEqual(record);
    expect(EvidencePack.parse(evidence)).toEqual(evidence);
    expect(TriageRecord.safeParse({ ...record, risk: "huge" }).success).toBe(false);
    expect(EvidencePack.safeParse({ ...evidence, format: "slides" }).success).toBe(false);
  });
  it("carry a video's verdict, scores and defects, and a note when a format was degraded", () => {
    const video = { file: "walkthrough.mp4", durationS: 92.4, verdict: "ship", scores: { hook: 8, clarity: 9 }, rounds: 1, defects: [{ priority: "P1", t: 12.5, scene: "cart", element: "cta", symptom: "the headline is cut off", fix: "shorten the heading to two lines" }], transcript: "Here is the cart." };
    const rich = { ...evidence, format: "video", note: "the critic passed round 2", video, media: [{ kind: "video", label: "walkthrough", url: "w.mp4" }, { kind: "cover", label: "cover", url: "c.jpg" }, { kind: "captions", label: "captions", url: "c.srt" }, { kind: "audio", label: "voice", url: "v.wav" }] };
    expect(EvidencePack.parse(rich)).toEqual(rich);
    expect(EvidencePack.parse({ ...evidence, video: null }).video).toBeNull();
    expect(EvidencePack.safeParse({ ...rich, video: { ...video, verdict: "maybe" } }).success).toBe(false);
    expect(EvidencePack.safeParse({ ...rich, video: { ...video, defects: [{ ...video.defects[0], priority: "P9" }] } }).success).toBe(false);
  });
  it("ride on the stage input's task, absent or null for a task without them", () => {
    const task = { ...stageInputExample.task, record, evidence };
    expect(StageInput.parse({ ...stageInputExample, task }).task).toMatchObject({ record, evidence });
    expect(StageInput.parse({ ...stageInputExample, task: { ...stageInputExample.task, record: null, evidence: null } }).task.record).toBeNull();
    expect(StageInput.parse(stageInputExample).task.record).toBeUndefined();
  });
});

describe("EvidenceContext and head_moved", () => {
  const e2e = { ran: true, verdict: "pass", hasVideo: true, hasSteps: true, scenarios: 3, skippedReason: null };
  const context = { record: null, risk: "low", webSurface: true, e2e, videoImage: false };
  it("is what evidence_format reads, and rides on the stage input's context", () => {
    expect(EvidenceContext.parse(context)).toEqual(context);
    expect(EvidenceContext.parse({ ...context, record: null, risk: null, changed: ["a.ts"] }).changed).toEqual(["a.ts"]);
    expect(EvidenceContext.safeParse({ ...context, risk: "huge" }).success).toBe(false);
    expect(EvidenceContext.safeParse({ ...context, e2e: { ...e2e, scenarios: 1.5 } }).success).toBe(false);
    expect(StageInput.parse({ ...stageInputExample, schema: 3, context: { projectContext: null, evidence: context } }).context.evidence).toEqual(context);
  });
  it("head_moved is an escalation reason", () => {
    expect(EscalationReason.options).toContain("head_moved");
  });
});

describe("the video packs", () => {
  const video = (id: "video_script" | "video_fix" | "recording" | "video_qa") => PACKS[id] as Exclude<(typeof PACKS)[typeof id], { kind: "decision" }>;

  it("video_script and video_fix are the video director on sonnet: they answer the script and the timeline and can write nothing, not even /out", () => {
    for (const id of ["video_script", "video_fix"] as const) {
      expect(video(id)).toMatchObject({ kind: "agent", agent: "video-director", helpers: [], skills: ["video-script"], writable: false, maxTurns: 25, timeoutMs: 600_000, effort: "medium", template: `${id}.md`, engines: { default: "claude:sonnet", allowed: ["claude:sonnet"] } });
      expect(video(id).access).toMatchObject({ read: true, write: false });
    }
  });

  it("recording is the demo recorder: the QA skills and a browser job's commands, 40 turns, 20 minutes", () => {
    expect(video("recording")).toMatchObject({ agent: "demo-recorder", skills: ["demo-recording", "qa-targets", "playwright-qa"], writable: true, maxTurns: 40, timeoutMs: 1_200_000, effort: "medium", template: "recording.md", engines: { default: "claude:sonnet", allowed: ["claude:sonnet"] } });
    expect(video("recording").access.commands).toEqual(expect.arrayContaining(["node", "npx", "npx playwright", "ffmpeg", "curl", "command -v"]));
  });

  it("video_qa is a read-only critic that defaults to haiku and may fall back to codex:sol", () => {
    expect(video("video_qa")).toMatchObject({ agent: "video-critic", skills: ["video-critic"], writable: false, maxTurns: 12, timeoutMs: 480_000, template: "video_qa.md", engines: { default: "claude:haiku", allowed: ["claude:haiku", "codex:sol"], fallback: ["codex:sol"] } });
    expect(video("video_qa").access).toMatchObject({ read: true, write: false });
  });

  it("answers: the script pair gives a script and a timeline, the recorder its marks, the critic scores and defects", () => {
    expect(AgentRole.options).toEqual(expect.arrayContaining(["video-director", "demo-recorder", "video-critic"]));
    const script = { script: "# s", timeline: { meta: {} }, facts: [{ claim: "c", source: "s" }], durationEstimateS: 60 };
    expect(PACKS.video_script.answer.safeParse(script).success).toBe(true);
    expect(PACKS.video_fix.answer.safeParse({ ...script, kind: "escalated", escalation: "other", reason: "r" }).success).toBe(true);
    expect(PACKS.video_script.answer.safeParse({ ...script, durationEstimateS: "long" }).success).toBe(false);
    expect(PACKS.recording.answer.safeParse({ timing: { marks: [{ scene: "a", t: 1.5 }] }, recordingPath: "/out/files/video/recording.webm", scenesRecorded: ["a"] }).success).toBe(true);
    const scores = { hook: 8, clarity: 8, readability: 8, motion: 8, rhythm: 8, composition: 8, continuity: 8, truth: 8, sync: 8 };
    const qa = { message: "ships", verdict: "ship", scores, defects: [{ priority: "P1", t: 12.5, scene: "cart", element: "cta", symptom: "cut off", mechanism: "overflow", fix: "wrap the heading" }], weakestScene: "cart" };
    expect(PACKS.video_qa.answer.safeParse(qa).success).toBe(true);
    expect(PACKS.video_qa.answer.safeParse({ ...qa, scores: { ...scores, hook: 11 } }).success).toBe(false);
    expect(PACKS.video_qa.answer.safeParse({ ...qa, verdict: "degraded" }).success).toBe(false);
  });
});

describe("VideoContext", () => {
  const context = {
    scenarios: [{ title: "A coupon counts once", criterion: "c1", approach: "apply twice" }],
    record: null,
    pack: { summary: "s", howToVerify: "open it", risk: "low" },
    steps: ['{"scenario":"a","step":"click"}'],
    chapters: [{ title: "A", start: 0 }],
    target: { name: "local", baseUrl: "http://127.0.0.1:3000", credential: null },
    narration: [{ id: "a", durationS: 12.5 }],
    timeline: null,
    report: null,
    transcript: null,
    sheets: ["/evidence/sheets/beats_sheet.jpg"],
    fixCards: [{ t: 12.5, scene: "cart", element: "cta", text: "cut off", priority: "P1" }],
  };
  it("is what the video packs read, and rides on the stage input's context", () => {
    expect(VideoContext.parse(context)).toEqual(context);
    expect(VideoContext.safeParse({ ...context, steps: Array.from({ length: 401 }, () => "x") }).success).toBe(false);
    expect(VideoContext.safeParse({ ...context, fixCards: [{ t: null, scene: null, element: null, text: "x", priority: "P3" }] }).success).toBe(false);
    expect(StageInput.parse({ ...stageInputExample, schema: 3, context: { projectContext: null, video: context } }).context.video).toEqual(context);
  });
});
