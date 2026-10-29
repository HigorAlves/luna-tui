import { describe, expect, it } from "vitest";

import { type PrNode, canPush, fromGraphQl, needsMe, splitOf } from "./pull-request.ts";

const checkRun = (name: string, status: string, conclusion: string | null) => ({
  __typename: "CheckRun",
  name,
  status,
  conclusion,
  detailsUrl: `https://github.com/o/a/actions/runs/1/job/${name}`,
});
const statusContext = (context: string, state: string) => ({ __typename: "StatusContext", context, state, targetUrl: null });

function node(overrides: Partial<PrNode> & { contexts?: unknown[] } = {}): PrNode {
  const { contexts, ...rest } = overrides;
  return {
    number: 12,
    title: "Export CSV",
    url: "https://github.com/o/a/pull/12",
    isDraft: false,
    updatedAt: "2026-10-27T10:00:00Z",
    baseRefName: "main",
    headRefName: "feat/export",
    author: { login: "me" },
    headRepository: { nameWithOwner: "o/a" },
    reviewDecision: null,
    mergeable: "MERGEABLE",
    reviewRequests: { nodes: [] },
    reviewThreads: { nodes: [] },
    commits: {
      nodes: [{ commit: { statusCheckRollup: contexts ? { state: "x", contexts: { nodes: contexts as never } } : null } }],
    },
    ...rest,
  };
}

const facts = (overrides: Partial<PrNode> & { contexts?: unknown[] } = {}, me = "me") => fromGraphQl(node(overrides), "o/a", me, []);

const green = [checkRun("build", "COMPLETED", "SUCCESS"), checkRun("test", "COMPLETED", "SUCCESS")];
const red = [checkRun("build", "COMPLETED", "SUCCESS"), checkRun("lint", "COMPLETED", "FAILURE")];
const running = [checkRun("build", "IN_PROGRESS", null)];

describe("fromGraphQl", () => {
  it("counts CheckRuns and StatusContexts alike and keeps the failed ones", () => {
    const pr = facts({ contexts: [checkRun("build", "COMPLETED", "SUCCESS"), statusContext("lint", "FAILURE"), checkRun("e2e", "QUEUED", null)] });
    expect(pr.checks).toEqual({
      state: "failure",
      passed: 1,
      total: 3,
      failed: [{ name: "lint", state: "FAILURE", url: null }],
      all: [
        { name: "build", state: "SUCCESS", url: "https://github.com/o/a/actions/runs/1/job/build" },
        { name: "lint", state: "FAILURE", url: null },
        { name: "e2e", state: "QUEUED", url: "https://github.com/o/a/actions/runs/1/job/e2e" },
      ],
    });
    expect(facts({ contexts: green }).checks.state).toBe("success");
    expect(facts({ contexts: running }).checks.state).toBe("pending");
    expect(facts({}).checks).toEqual({ state: "none", passed: 0, total: 0, failed: [], all: [] });
    expect(facts({ contexts: [checkRun("docs", "COMPLETED", "SKIPPED")] }).checks.state).toBe("success");
  });

  it("knows whose PR it is, who was asked, and whether the head is a fork", () => {
    expect(facts({}).mine).toBe(true);
    expect(facts({ author: { login: "them" } }).mine).toBe(false);
    expect(facts({ author: { login: "them" }, reviewRequests: { nodes: [{ requestedReviewer: { login: "me" } }] } }).reviewRequested).toBe(true);
    expect(fromGraphQl(node({ author: { login: "them" }, reviewRequests: { nodes: [{ requestedReviewer: { slug: "core" } }] } }), "o/a", "me", ["core"]).reviewRequested).toBe(true);
    expect(facts({ reviewRequests: { nodes: [{ requestedReviewer: { login: "someone" } }] } }).reviewRequested).toBe(false);
    expect(facts({ headRepository: { nameWithOwner: "someone/a" } }).fromFork).toBe(true);
    expect(facts({ headRepository: null }).fromFork).toBe(true);
    expect(facts({}).fromFork).toBe(false);
  });

  it("counts only the unresolved threads and carries the rest verbatim", () => {
    const pr = facts({ reviewThreads: { nodes: [{ isResolved: true }, { isResolved: false }, { isResolved: false }] }, reviewDecision: "APPROVED" });
    expect(pr.unresolvedThreads).toBe(2);
    expect(pr).toMatchObject({ repo: "o/a", number: 12, headRef: "feat/export", baseRef: "main", author: "me", reviewDecision: "APPROVED", updatedAt: "2026-10-27T10:00:00Z" });
  });
});

describe("splitOf", () => {
  const mine = (overrides: Partial<PrNode> & { contexts?: unknown[] } = {}) => splitOf(facts(overrides));
  const theirs = (overrides: Partial<PrNode> & { contexts?: unknown[] } = {}) => splitOf(facts({ author: { login: "them" }, ...overrides }));
  const asked = { reviewRequests: { nodes: [{ requestedReviewer: { login: "me" } }] } };

  it("a teammate's PR asking for my review is Review requested, even with red CI or a draft", () => {
    expect(theirs(asked)).toBe("review_requested");
    expect(theirs({ ...asked, contexts: red })).toBe("review_requested");
    expect(theirs({ ...asked, isDraft: true })).toBe("review_requested");
    expect(theirs({})).toBe("mine");
  });

  it("my PRs: CI failed, then changes requested, then ready, then CI running, then mine", () => {
    expect(mine({ contexts: red, reviewDecision: "CHANGES_REQUESTED" })).toBe("ci_failed");
    expect(mine({ contexts: green, reviewDecision: "CHANGES_REQUESTED" })).toBe("changes_requested");
    expect(mine({ contexts: green, reviewDecision: "APPROVED", reviewThreads: { nodes: [{ isResolved: false }] } })).toBe("changes_requested");
    expect(mine({ contexts: green, reviewDecision: "APPROVED" })).toBe("ready_to_merge");
    expect(mine({ reviewDecision: "APPROVED" })).toBe("ready_to_merge");
    expect(mine({ contexts: green, reviewDecision: "APPROVED", mergeable: "CONFLICTING" })).toBe("mine");
    expect(mine({ contexts: running, reviewDecision: "APPROVED" })).toBe("ci_running");
    expect(mine({ contexts: green, reviewDecision: "REVIEW_REQUIRED" })).toBe("mine");
  });

  it("a repo that asks for no review has no decision at all: green and mergeable is ready", () => {
    expect(mine({ contexts: green })).toBe("ready_to_merge");
    expect(mine({ contexts: green, mergeable: "CONFLICTING" })).toBe("mine");
    expect(mine({ contexts: green, isDraft: true })).toBe("mine");
    expect(mine({ contexts: green, reviewThreads: { nodes: [{ isResolved: false }] } })).toBe("changes_requested");
    expect(mine({ contexts: running })).toBe("ci_running");
  });

  it("a draft of mine is never ready", () => {
    expect(mine({ contexts: green, reviewDecision: "APPROVED", isDraft: true })).toBe("mine");
    expect(mine({ contexts: red, isDraft: true })).toBe("ci_failed");
  });
});

describe("GitHub's merge state decides ready to merge", () => {
  const mine = (overrides: Partial<PrNode> & { contexts?: unknown[] } = {}) => splitOf(facts(overrides));
  const withState = (mergeStateStatus: string, over: Record<string, unknown> = {}) => mine({ contexts: green, ...over, mergeStateStatus } as never);

  it("CLEAN and HAS_HOOKS are ready whatever the review decision says, because GitHub says the button works", () => {
    expect(withState("CLEAN")).toBe("ready_to_merge");
    expect(withState("HAS_HOOKS", { reviewDecision: null })).toBe("ready_to_merge");
    expect(withState("CLEAN", { reviewDecision: "REVIEW_REQUIRED" })).toBe("ready_to_merge");
  });

  it("BLOCKED, BEHIND and DIRTY are not, even approved and green", () => {
    for (const state of ["BLOCKED", "BEHIND", "DIRTY", "DRAFT"]) {
      expect(withState(state, { reviewDecision: "APPROVED" }), state).toBe("mine");
    }
  });

  it("UNSTABLE is ready only when nothing is still running", () => {
    expect(withState("UNSTABLE")).toBe("ready_to_merge");
    expect(mine({ contexts: running, mergeStateStatus: "UNSTABLE" } as never)).toBe("ci_running");
  });

  it("a draft is never ready, and an unresolved thread still sends it to changes requested", () => {
    expect(withState("CLEAN", { isDraft: true })).toBe("mine");
    expect(withState("CLEAN", { reviewThreads: { nodes: [{ isResolved: false }] } })).toBe("changes_requested");
  });
});

describe("needsMe and canPush", () => {
  it("four splits need you; pushing needs a checkout and no fork", () => {
    expect(["review_requested", "ready_to_merge", "ci_failed", "changes_requested"].every((s) => needsMe(s as never))).toBe(true);
    expect(needsMe("ci_running")).toBe(false);
    expect(needsMe("mine")).toBe(false);
    expect(canPush({ fromFork: false, localPath: "/r/a" })).toBe(true);
    expect(canPush({ fromFork: true, localPath: "/r/a" })).toBe(false);
    expect(canPush({ fromFork: false, localPath: null })).toBe(false);
  });
});
