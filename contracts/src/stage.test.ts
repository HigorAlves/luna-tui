import { describe, expect, it } from "vitest";

import {
  AgentRole,
  ArtifactKind,
  CloneInput,
  COLUMN_OF,
  MergeInput,
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
  ThreadsContext,
  VerifyResult,
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
  it("has the eleven stage packs, each named after a task state, plus the Slack, Datadog and Jira intake triages", () => {
    expect([...PackId.options].sort()).toEqual(
      ["setup", "triage", "test_design", "implementing", "verifying", "e2e", "evidence", "ci_watch", "reviewing_memory", "reviewing", "addressing", "slack_triage", "datadog_triage", "jira_intake"].sort(),
    );
    for (const pack of PackId.options) {
      if (pack === "slack_triage" || pack === "datadog_triage" || pack === "jira_intake") expect(TaskState.options).not.toContain(pack);
      else expect(TaskState.options).toContain(pack);
    }
  });
});

describe("slack_triage", () => {
  it("runs as the slack-triager on haiku, low effort, three turns, no tools and no worktree", () => {
    expect(PACKS.slack_triage).toMatchObject({ agent: "slack-triager", helpers: [], skills: [], tools: [], writable: false, maxTurns: 3, model: "haiku", effort: "low", template: "slack_triage.md" });
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

describe("ArtifactKind", () => {
  it("lists the nine kinds", () => {
    expect(ArtifactKind.options).toHaveLength(9);
  });
});

describe("PR tasks", () => {
  it("a PR source carries its head and base; an issue source is unchanged", () => {
    const pr = TaskSource.parse({ kind: "github_pr", repo: "a/b", number: 7, url: "u", headRef: "feat/x", baseRef: "main" });
    expect(pr.kind).toBe("github_pr");
    expect(() => TaskSource.parse({ kind: "github_pr", repo: "a/b", number: 7, url: "u" })).toThrow();
    expect(TaskSource.parse({ kind: "github", repo: "a/b", number: 7, url: "u" }).kind).toBe("github");
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
    expect(PACKS.reviewing).toMatchObject({ agent: "pr-reviewer", helpers: ["security-reviewer"] });
    expect(PACKS.reviewing.skills).toEqual(expect.arrayContaining(["inline-review", "review-contract", "caveman-review"]));
    expect(PACKS.addressing).toMatchObject({ agent: "code-fixer", helpers: ["reply-drafter"] });
    expect(PACKS.addressing.skills).toEqual(expect.arrayContaining(["receiving-code-review", "verification-before-completion"]));
    for (const pack of Object.values(PACKS)) {
      expect(Array.isArray(pack.helpers), pack.id).toBe(true);
      // A role with helpers needs the Agent tool to dispatch them; one without must not carry it.
      expect(pack.tools.includes("Agent"), pack.id).toBe(pack.helpers.length > 0);
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
