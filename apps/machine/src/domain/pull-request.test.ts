import { describe, expect, it } from "vitest";

import type { PullRequest } from "@hardness/contracts";

import { type PrNode, actionsOf, canPush, fromGraphQl, needsMe, prFields, splitOf } from "./pull-request.ts";

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
  it("keeps GitHub's author association of the PR, and none when the node has none", () => {
    expect(facts({ authorAssociation: "FIRST_TIME_CONTRIBUTOR" }).authorAssociation).toBe("FIRST_TIME_CONTRIBUTOR");
    expect(facts({}).authorAssociation).toBeUndefined();
    expect(prFields({ requests: 1, threads: 1, contexts: 1 })).toContain("authorAssociation");
  });

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

  it("maps the head commit, its date, the node id and the body, and null when a fixture has none", () => {
    const oid = "9c1f0e2a7b3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f";
    const pr = facts({ id: "PR_node1", body: "Depends on #7", commits: { nodes: [{ commit: { oid, committedDate: "2026-11-01T09:00:00Z", statusCheckRollup: null } }] } });
    expect(pr).toMatchObject({ headSha: oid, headCommittedAt: "2026-11-01T09:00:00Z", nodeId: "PR_node1", body: "Depends on #7" });
    expect(facts({})).toMatchObject({ headSha: null, headCommittedAt: null, nodeId: null, body: null });
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

describe("when a PR began waiting, and whether its threads were read in full", () => {
  it("carries when it was opened, and falls back on its last update when a fixture has none", () => {
    expect(facts({ createdAt: "2026-10-20T08:00:00Z" }).createdAt).toBe("2026-10-20T08:00:00Z");
    expect(facts({}).createdAt).toBe("2026-10-27T10:00:00Z");
    expect(prFields({ requests: 1, threads: 1, contexts: 1 })).toContain("createdAt");
  });

  it("says when your review was last asked, by you or a team you are in, and null when it was not", () => {
    const asked = (login: string | null, slug: string | null, createdAt: string) => ({ createdAt, requestedReviewer: login ? { login } : slug ? { slug } : null });
    const timelineItems = { nodes: [asked("me", null, "2026-10-21T09:00:00Z"), asked("other", null, "2026-10-23T09:00:00Z"), asked(null, "core", "2026-10-22T09:00:00Z")] };
    const pr = fromGraphQl(node({ author: { login: "them" }, timelineItems }), "o/a", "me", ["core"]);
    expect(pr.reviewRequestedAt).toBe("2026-10-22T09:00:00Z");
    expect(facts({ timelineItems: { nodes: [asked("other", null, "2026-10-23T09:00:00Z")] } }).reviewRequestedAt).toBeNull();
    expect(facts({}).reviewRequestedAt).toBeNull();
    expect(prFields({ requests: 1, threads: 1, contexts: 1 })).toContain("REVIEW_REQUESTED_EVENT");
  });

  it("knows threads were cut short when GitHub counts more than it listed, and sends such a PR of yours to changes requested", () => {
    expect(facts({ reviewThreads: { totalCount: 1, nodes: [{ isResolved: true }] } }).threadsComplete).toBe(true);
    expect(facts({}).threadsComplete).toBe(true);
    const cut = facts({ contexts: green, reviewDecision: "APPROVED", reviewThreads: { totalCount: 140, nodes: [{ isResolved: true }] } });
    expect(cut.threadsComplete).toBe(false);
    expect(splitOf(cut)).toBe("changes_requested");
    expect(prFields({ requests: 1, threads: 1, contexts: 1 })).toContain("totalCount");
  });
});

describe("actionsOf: each action, and why it can't run", () => {
  const base = (over: Partial<PullRequest> = {}): Omit<PullRequest, "actions"> => {
    const f = facts({ contexts: red });
    const pr = { ...f, split: splitOf(f), localPath: "/r/a", task: null, ...over };
    return { ...pr, split: over.split ?? splitOf(pr) };
  };
  const reasons = (pr: Omit<PullRequest, "actions">) => Object.fromEntries(actionsOf(pr).map((a) => [a.action, a.reason]));

  it("lists every action in the menu's order, allowed exactly when nothing stands in the way", () => {
    const got = actionsOf(base());
    expect(got.map((a) => a.action)).toEqual(["ci_fix", "address", "review", "merge", "close"]);
    for (const a of got) expect(a.allowed).toBe(a.reason === null);
  });

  it("my red PR: Fix CI runs; the rest say why, in the TUI's words", () => {
    expect(reasons(base())).toEqual({
      ci_fix: null,
      address: "no unresolved threads",
      review: "review is for other people's PRs",
      merge: "a check is red",
      close: null,
    });
  });

  it("Merge is off in GitHub's words when its merge state says so, and on only when ready to merge", () => {
    expect(reasons(base({ mergeState: "BEHIND" })).merge).toBe("GitHub: the branch is behind its base; update it first");
    expect(reasons(base({ mergeState: "BLOCKED" })).merge).toBe("GitHub: blocked, a required review or check is still missing");
    expect(reasons(base({ split: "ready_to_merge" })).merge).toBeNull();
  });

  it("a task at work blocks every dispatch and Close; a card only watching the PR blocks nothing", () => {
    const busy = reasons(base({ task: { id: "t1", state: "ci_watch", route: "ci_fix" } }));
    expect([busy.ci_fix, busy.address, busy.review, busy.close]).toEqual(Array(4).fill("a task is already running for it"));
    expect(reasons(base({ task: { id: "t1", state: "pr_watch", route: "ci_fix" } })).ci_fix).toBeNull();
  });

  it("no checkout: the agents wait for a clone, and say whether a clone is all they need", () => {
    const got = actionsOf(base({ localPath: null }));
    const fix = got.find((a) => a.action === "ci_fix")!;
    expect(fix).toMatchObject({ allowed: false, reason: "no checkout", needsClone: true });
    expect(got.find((a) => a.action === "review")).toMatchObject({ reason: "no checkout", needsClone: false });
    expect(got.find((a) => a.action === "close")!.needsClone).toBe(false);
    // A fork can't be pushed to, cloned or not: that is its reason, and no clone would help.
    expect(actionsOf(base({ localPath: null, fromFork: true })).find((a) => a.action === "ci_fix")).toMatchObject({ reason: "the head is in a fork; nothing can push to it", needsClone: false });
  });

  it("someone else's PR: review only, never close, threads or a fix on a fork", () => {
    const theirs = reasons(base({ mine: false, reviewRequested: true, fromFork: true }));
    expect(theirs).toMatchObject({
      review: null,
      close: "closing is for your own PRs",
      address: "the head is in a fork; nothing can push to it",
      ci_fix: "the head is in a fork; nothing can push to it",
    });
  });

  it("Fix CI wants a red check; Answer threads wants a thread open or a change asked", () => {
    const green = base({ checks: { state: "success", passed: 1, total: 1, failed: [], all: [] } });
    expect(reasons(green).ci_fix).toBe("checks are green");
    expect(reasons(base({ checks: { state: "pending", passed: 0, total: 1, failed: [], all: [] } })).ci_fix).toBe("checks are still running");
    expect(reasons(base({ checks: { state: "none", passed: 0, total: 0, failed: [], all: [] } })).ci_fix).toBe("there are no checks");
    expect(reasons(base({ unresolvedThreads: 2 })).address).toBeNull();
    expect(reasons(base({ reviewDecision: "CHANGES_REQUESTED" })).address).toBeNull();
    expect(reasons(base({ threadsComplete: false })).address).toBeNull();
  });
});
