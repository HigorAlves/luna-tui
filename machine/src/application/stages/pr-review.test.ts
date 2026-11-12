import { describe, expect, it, vi } from "vitest";

import type { ApprovalRow, TaskRow } from "../../domain/task.ts";
import { fakeGitHub } from "../../test/github.ts";
import { fakeJira } from "../../test/jira.ts";
import type { Jira } from "../jira.ts";
import type { LinkableCard, PrLinkDeps } from "../pr-link.ts";
import type { StageContext, StageResult } from "../ports.ts";
import { MAX_INLINE_COMMENTS, type PrReviewDeps, capComments, postVerdictRunner, prReviewRunner } from "./pr-review.ts";

const node = {
  number: 12,
  title: "Export CSV",
  body: "Adds the export.",
  url: "https://github.com/o/a/pull/12",
  isDraft: false,
  updatedAt: "t",
  baseRefName: "main",
  headRefName: "feat/export",
  author: { login: "them" },
  headRepository: { nameWithOwner: "o/a" },
  reviewDecision: null,
  mergeable: "MERGEABLE",
  reviewRequests: { nodes: [] },
  reviewThreads: { nodes: [] },
  commits: { nodes: [] },
};

function setup(answer: Record<string, unknown> | null, opts: { postFails?: boolean; title?: string; jira?: Jira; projects?: () => Promise<string[]>; links?: PrReviewDeps["links"] } = {}) {
  const github = fakeGitHub({
    prFacts: async () => (opts.title ? { ...node, title: opts.title } : node) as never,
    prDiff: async () => "diff --git a/a.ts b/a.ts\n+export const x = 1;\n",
    prFiles: async () => [{ path: "a.ts", additions: 1, deletions: 0 }],
    prComments: async () => [{ path: "a.ts", line: 1, author: "x", body: "old" }],
    postReview: async () => {
      if (opts.postFails) throw new Error("posting a review failed (422): Unprocessable");
    },
  });
  let seen: unknown;
  const runPack = async (_context: StageContext, review: unknown): Promise<StageResult> => {
    seen = review;
    return answer ? { outcome: "pass", detail: { answer, summary: String(answer.summary) } } : { outcome: "escalated", detail: { reason: "unclear" } };
  };
  const context = {
    task: {
      id: "t1",
      route: "review",
      branch: "feat/export",
      worktreePath: "/wt",
      repoPath: "/r/a",
      source: { kind: "github_pr", repo: "o/a", number: 12, url: node.url, headRef: "feat/export", baseRef: "main" },
    } as unknown as TaskRow,
    stage: "reviewing",
    attempt: 1,
    runId: "r1",
    approvals: [],
    signal: new AbortController().signal,
  } as StageContext;
  return { run: prReviewRunner({ github, runPack, ...(opts.jira ? { jira: opts.jira } : {}), ...(opts.projects ? { projects: opts.projects } : {}), ...(opts.links ? { links: opts.links } : {}) }), context, github, review: () => seen };
}

const posted = (github: ReturnType<typeof fakeGitHub>) => github.postReview.mock.calls;

describe("reviewing", () => {
  it("hands the pack the diff, files and existing comments, posts nothing, and waits for you with the whole review", async () => {
    const { run, context, github, review } = setup({
      verdict: "comment",
      summary: "Two nits.",
      findings: [{ path: "a.ts", line: 1, severity: "nit", title: "nit", body: "nit", confidence: 0.9 }],
      comments: [{ path: "a.ts", line: 1, side: "RIGHT", body: "nit" }],
    });
    const result = await run(context);
    expect(review()).toMatchObject({
      pr: { repo: "o/a", number: 12, title: "Export CSV", body: "Adds the export.", author: "them", baseRef: "main", headRef: "feat/export" },
      files: [{ path: "a.ts", additions: 1, deletions: 0 }],
      existingComments: [{ path: "a.ts", line: 1, author: "x", body: "old" }],
    });
    expect(String((review() as { diff: string }).diff)).toContain("+export const x = 1;");
    expect(posted(github)).toHaveLength(0);
    expect(result).toMatchObject({ outcome: "pass", detail: { verdict: "comment", posted: false, reason: "verdict", comments: 1 } });
    expect(result.requested).toEqual([
      { kind: "pr_review_post", target: node.url, payload: { event: "COMMENT", body: "Two nits.", comments: [{ path: "a.ts", line: 1, side: "RIGHT", body: "nit" }] } },
    ]);
  });

  it("waits for you with the verdict and its comments when it is approve or request changes", async () => {
    const { run, context, github } = setup({ verdict: "request_changes", summary: "Blocking.", findings: [{ path: "a.ts", line: 1, severity: "bug", title: "bug", body: "bug", confidence: 0.9 }], comments: [{ path: "a.ts", line: 1, body: "bug" }] });
    const result = await run(context);
    expect(posted(github)).toHaveLength(0);
    expect(result).toMatchObject({ outcome: "pass", detail: { reason: "verdict", verdict: "request_changes", posted: false } });
    expect(result.requested).toEqual([
      { kind: "pr_review_post", target: node.url, payload: { event: "REQUEST_CHANGES", body: "Blocking.", comments: [{ path: "a.ts", line: 1, side: "RIGHT", body: "bug" }] } },
    ]);
  });

  it("waits for you even with no comment, and passes an escalation through", async () => {
    const quiet = setup({ verdict: "approve", summary: "Looks fine.", findings: [], comments: [] });
    const result = await quiet.run(quiet.context);
    expect(posted(quiet.github)).toHaveLength(0);
    expect(result.detail).toMatchObject({ posted: false, reason: "verdict" });
    const escalated = setup(null);
    expect((await escalated.run(escalated.context)).outcome).toBe("escalated");
  });
});

describe("reviewing against the Jira tickets the PR names", () => {
  const answer = { verdict: "approve", summary: "Fine.", findings: [], comments: [] };
  const issues = [{ key: "DISC-939", summary: "Stale feedback", issueType: "Bug", status: "In Review", description: "Do it.\n\n## Acceptance criteria\n- removes rows" }];

  it("hands the pack the tickets the title names and puts their keys and summaries in the stage detail", async () => {
    const { run, context, review } = setup(answer, { title: "Export CSV (DISC-939)", jira: fakeJira({ issues }) });
    const result = await run(context);
    expect((review() as { tickets: unknown[] }).tickets).toEqual([
      expect.objectContaining({ key: "DISC-939", url: "https://acme.atlassian.net/browse/DISC-939", type: "Bug", status: "In Review", summary: "Stale feedback", acceptanceCriteria: "- removes rows" }),
    ]);
    expect(result.detail).toMatchObject({ tickets: [{ key: "DISC-939", url: "https://acme.atlassian.net/browse/DISC-939", summary: "Stale feedback" }] });
  });

  it("skips a ticket Jira fails on without failing the review", async () => {
    const jira = fakeJira({ issues });
    const base = jira.issue.bind(jira);
    const flaky: Jira = { ...jira, issue: async (key) => (key === "DISC-1" ? Promise.reject(new Error("boom")) : base(key)) };
    const { run, context, review } = setup(answer, { title: "DISC-1 Export", jira: flaky });
    const first = await run(context);
    expect(first.outcome).toBe("pass");
    expect((review() as { tickets: unknown[] }).tickets).toEqual([]);
    expect(first.detail).not.toHaveProperty("tickets");
  });

  it("gives no tickets without a Jira port, and none outside the repo's projects", async () => {
    const bare = setup(answer, { title: "Export CSV (DISC-939)" });
    await bare.run(bare.context);
    expect((bare.review() as { tickets?: unknown[] }).tickets ?? []).toEqual([]);
    const other = setup(answer, { title: "Export CSV (DISC-939)", jira: fakeJira({ issues }), projects: async () => ["PLAT"] });
    await other.run(other.context);
    expect((other.review() as { tickets?: unknown[] }).tickets ?? []).toEqual([]);
  });
});

describe("reviewing against the board cards and tickets the PR is linked to", () => {
  const answer = { verdict: "approve", summary: "Fine.", findings: [], comments: [] };
  const issues = [
    { key: "DISC-939", summary: "Stale feedback", issueType: "Bug", status: "In Review", description: "Do it." },
    { key: "DISC-12", summary: "Export to CSV", issueType: "Story", status: "To Do", description: "Users want a CSV." },
  ];
  const jiraLink = (key: string) => ({ key, url: `https://acme.atlassian.net/browse/${key}`, issueType: "Story", status: "To Do", priority: null, dueAt: null, syncedAt: null, blocked: null });
  const card = (over: Partial<LinkableCard> & { id: string }): LinkableCard => ({ title: `Card ${over.id}`, description: "", criteria: [], state: "implementing", route: "feature", repoPath: "/r/a", branch: null, source: null, jira: null, stateSince: null, ...over });
  const links = (cards: LinkableCard[], extra: Partial<PrLinkDeps> = {}) => {
    const record = vi.fn(async (_taskId: string, _links: unknown, _pr: unknown) => {});
    return { record, deps: { cards: async () => cards, prUrls: async () => [] as string[], record, ...extra } satisfies PrReviewDeps["links"] };
  };
  const decision = (answer: Record<string, unknown>) => {
    const decide = vi.fn(async (_context: unknown) => answer);
    return { decide, decision: { available: async () => true, decide, overrides: async () => ({}) } };
  };

  it("hands the pack a card matched by its branch, with its criteria and description, and records the link on the review and the card", async () => {
    const board = [card({ id: "c1", title: "Export CSV", description: "Add the export.", criteria: ["rows are exported"], branch: "feat/export" }), card({ id: "c2", branch: "feat/other" })];
    const { record, deps } = links(board);
    const { run, context, review } = setup(answer, { links: deps });
    const result = await run(context);
    expect((review() as { cards: unknown[] }).cards).toEqual([{ id: "c1", title: "Export CSV", criteria: ["rows are exported"], description: "Add the export." }]);
    const expected = { at: expect.any(String), jira: [], cards: [{ id: "c1", title: "Export CSV", how: "fact", fact: "branch" }] };
    expect(result.detail).toMatchObject({ links: expected });
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith("t1", expected, { url: node.url, number: 12, repo: "o/a" });
  });

  it("fetches the Jira ticket of a linked card that the PR did not name and reads it like a named one", async () => {
    const { deps } = links([card({ id: "c1", branch: "feat/export", jira: jiraLink("DISC-12") })]);
    const { run, context, review } = setup(answer, { jira: fakeJira({ issues }), links: deps });
    const result = await run(context);
    expect((review() as { tickets: Array<{ key: string }> }).tickets.map((t) => t.key)).toEqual(["DISC-12"]);
    expect(result.detail).toMatchObject({
      tickets: [{ key: "DISC-12" }],
      links: { jira: [{ key: "DISC-12", url: "https://acme.atlassian.net/browse/DISC-12", summary: "Export to CSV", how: "fact" }], cards: [{ id: "c1", how: "fact", fact: "branch" }] },
    });
  });

  it("marks a ticket the PR names as `key`, and never asks the decision", async () => {
    const asked = decision({ match: { choice: "slot1", confidence: 0.99 } });
    const { deps } = links([], { decision: asked.decision });
    const { run, context } = setup(answer, { title: "Export (DISC-939)", jira: fakeJira({ issues }), links: deps });
    const result = await run(context);
    expect(result.detail).toMatchObject({ links: { jira: [{ key: "DISC-939", how: "key" }], cards: [] } });
    expect(asked.decide).not.toHaveBeenCalled();
  });

  it("links what the decision picks above its bar, and the reviewer reads it like a named ticket", async () => {
    const asked = decision({ match: { choice: "slot2", confidence: 0.9 } });
    const board = [card({ id: "c1", title: "Export the table", description: "Add a CSV.", criteria: ["a"] })];
    const { record, deps } = links(board, { decision: asked.decision });
    const { run, context, review } = setup(answer, { jira: fakeJira({ issues: [issues[1]!] }), projects: async () => ["DISC"], links: deps });
    const result = await run(context);
    expect(asked.decide).toHaveBeenCalledTimes(1);
    expect((review() as { cards: Array<{ id: string }> }).cards.map((c) => c.id)).toEqual(["c1"]);
    expect(result.detail).toMatchObject({ links: { jira: [], cards: [{ id: "c1", how: "decision" }] } });
    expect(result.detail).not.toHaveProperty("links.suggestion");
    expect(record).toHaveBeenCalledTimes(1);
  });

  it("under the bar it links nothing, hands the reviewer nothing and keeps the suggestion", async () => {
    const asked = decision({ match: { choice: "slot1", confidence: 0.55 } });
    const { record, deps } = links([], { decision: asked.decision });
    const { run, context, review } = setup(answer, { jira: fakeJira({ issues: [issues[1]!] }), projects: async () => ["DISC"], links: deps });
    const result = await run(context);
    expect((review() as { tickets: unknown[]; cards?: unknown[] }).tickets).toEqual([]);
    expect((review() as { cards?: unknown[] }).cards ?? []).toEqual([]);
    const expected = { at: expect.any(String), jira: [], cards: [], suggestion: { kind: "jira", id: "DISC-12", title: "Export to CSV", confidence: 0.55, url: "https://acme.atlassian.net/browse/DISC-12" } };
    expect(result.detail).toMatchObject({ links: expected });
    expect(record).toHaveBeenCalledWith("t1", expected, expect.anything());
  });

  it("records nothing and puts no links in the detail when nothing linked and nothing was suggested", async () => {
    const { record, deps } = links([card({ id: "c1", branch: "feat/other" })]);
    const { run, context, review } = setup(answer, { links: deps });
    const result = await run(context);
    expect(result.detail).not.toHaveProperty("links");
    expect((review() as { cards?: unknown[] }).cards).toBeUndefined();
    expect(record).not.toHaveBeenCalled();
  });

  it("never fails the review when recording the links fails, and records nothing when the review did not pass", async () => {
    const board = [card({ id: "c1", branch: "feat/export" })];
    const bad = links(board);
    bad.record.mockRejectedValue(new Error("db down"));
    const ok = setup(answer, { links: bad.deps });
    expect((await ok.run(ok.context)).outcome).toBe("pass");
    const failed = links(board);
    const escalated = setup(null, { links: failed.deps });
    expect((await escalated.run(escalated.context)).outcome).toBe("escalated");
    expect(failed.record).not.toHaveBeenCalled();
  });

  it("still reads the cards when Jira is not configured", async () => {
    const { deps } = links([card({ id: "c1", branch: "feat/export", jira: jiraLink("DISC-12") })]);
    const { run, context, review } = setup(answer, { links: deps });
    const result = await run(context);
    expect((review() as { tickets?: unknown[] }).tickets).toBeUndefined();
    expect((review() as { cards: unknown[] }).cards).toHaveLength(1);
    expect(result.detail).toMatchObject({ links: { jira: [], cards: [{ id: "c1" }] } });
  });
});

describe("the verdict, computed from the findings (orc review-contract)", () => {
  const finding = (severity: string) => ({ path: "a.ts", line: 1, severity, title: severity, body: "b", confidence: 0.9 });
  it.each([
    [[], "approve", "APPROVE"],
    [["suggestion"], "comment", "COMMENT"],
    [["question", "nit"], "comment", "COMMENT"],
    [["test"], "request_changes", "REQUEST_CHANGES"],
    [["api-surface"], "request_changes", "REQUEST_CHANGES"],
    [["bug", "suggestion"], "request_changes", "REQUEST_CHANGES"],
    [["security"], "request_changes", "REQUEST_CHANGES"],
  ])("%j gives %s whatever the model said", async (severities, verdict, event) => {
    const { run, context } = setup({ verdict: "approve", summary: "Looks good.", findings: (severities as string[]).map(finding), comments: [] });
    const result = await run(context);
    expect(result.detail).toMatchObject({ verdict });
    expect((result.requested?.[0]?.payload as { event: string }).event).toBe(event);
  });

  it("records when the model's own verdict contradicted the findings", async () => {
    const { run, context } = setup({ verdict: "approve", summary: "LGTM.", findings: [finding("bug")], comments: [] });
    const result = await run(context);
    expect(result.detail).toMatchObject({ verdict: "request_changes", modelVerdict: "approve" });
  });
});

describe("posting the verdict", () => {
  const approval = (actions: unknown[], decision: ApprovalRow["decision"] = "approved"): ApprovalRow =>
    ({ id: "a1", taskId: "t1", kind: "awaiting_ship", requested: { actions }, decision, reason: null, response: null, createdAt: new Date(), decidedAt: new Date() }) as ApprovalRow;

  it("posts the review the gate carried, as its event, with its line comments", async () => {
    const github = fakeGitHub({ postReview: async () => {} });
    const run = postVerdictRunner({ github });
    const { context } = setup(null);
    const comments = [{ path: "a.ts", line: 1, side: "RIGHT", body: "nit" }];
    for (const event of ["APPROVE", "REQUEST_CHANGES", "COMMENT"]) {
      const result = await run({ ...context, stage: "shipping", approvals: [approval([{ kind: "pr_review_post", target: node.url, payload: { event, body: "LGTM", comments } }])] });
      expect(result.outcome, event).toBe("pass");
      expect(github.postReview).toHaveBeenLastCalledWith("o/a", 12, { event, body: "LGTM", comments });
    }
  });

  it("posts a gate stored before the comments rode on it with no comments", async () => {
    const github = fakeGitHub({ postReview: async () => {} });
    const run = postVerdictRunner({ github });
    const { context } = setup(null);
    await run({ ...context, stage: "shipping", approvals: [approval([{ kind: "pr_review_post", target: node.url, payload: { event: "APPROVE", body: "LGTM" } }])] });
    expect(github.postReview).toHaveBeenCalledWith("o/a", 12, { event: "APPROVE", body: "LGTM", comments: [] });
  });

  it("fails with gh's words when the post is refused", async () => {
    const github = fakeGitHub({ postReview: async () => { throw new Error("posting a review failed (422): Unprocessable"); } });
    const run = postVerdictRunner({ github });
    const { context } = setup(null);
    const result = await run({ ...context, stage: "shipping", approvals: [approval([{ kind: "pr_review_post", target: node.url, payload: { event: "COMMENT", body: "s", comments: [] } }])] });
    expect(result.outcome).toBe("fail");
    expect(String(result.detail?.error)).toMatch(/422/);
  });

  it("fails when the gate carried no review to post", async () => {
    const run = postVerdictRunner({ github: fakeGitHub() });
    const { context } = setup(null);
    const result = await run({ ...context, stage: "shipping", approvals: [approval([])] });
    expect(result.outcome).toBe("fail");
  });
});

describe("the comment cap", () => {
  it("keeps the gravest fifteen and the pack's order among equals", () => {
    const comments = Array.from({ length: 20 }, (_, i) => ({ path: "a.ts", line: i + 1 }));
    const findings = comments.map((c) => ({ ...c, severity: c.line === 20 ? "security" : c.line === 19 ? "bug" : "suggestion" }));
    const kept = capComments(comments, findings).map((c) => c.line);
    expect(kept).toHaveLength(MAX_INLINE_COMMENTS);
    expect(kept.slice(0, 2)).toEqual([20, 19]);
    expect(kept.slice(2)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    expect(capComments(comments.slice(0, 3), findings)).toHaveLength(3);
  });
});
