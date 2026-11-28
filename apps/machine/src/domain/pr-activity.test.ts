import type { PrSnapshot, PullRequest } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import { activityOf, digestOf } from "./pr-activity.ts";

const pr = (number: number, over: Partial<PullRequest> = {}): PullRequest => ({
  repo: "o/a",
  number,
  title: `PR ${number}`,
  url: `https://github.com/o/a/pull/${number}`,
  author: "me",
  mine: true,
  reviewRequested: false,
  isDraft: false,
  headRef: `feat/${number}`,
  baseRef: "main",
  fromFork: false,
  reviewDecision: null,
  mergeable: "MERGEABLE",
  mergeState: "UNKNOWN",
  checks: { state: "pending", passed: 0, total: 1, failed: [], all: [] },
  unresolvedThreads: 0,
  split: "ci_running",
  localPath: "/r/a",
  task: null,
  updatedAt: "2026-11-27T10:00:00Z",
  createdAt: "2026-11-26T10:00:00Z",
  reviewRequestedAt: null,
  threadsComplete: true,
  actions: [],
  headSha: null,
  headCommittedAt: null,
  nodeId: null,
  body: null,
  ...over,
});

const snap = (prs: PullRequest[], polledAt: string | null = "2026-11-27T10:00:00Z"): PrSnapshot => ({ prs, polledAt, error: null });
const AT = "2026-11-27T10:02:00Z";
const red = { state: "failure" as const, passed: 0, total: 1, failed: [{ name: "lint", state: "FAILURE", url: null }], all: [] };
const green = { state: "success" as const, passed: 1, total: 1, failed: [], all: [] };
const theirs = (number: number) => pr(number, { author: "them", mine: false, reviewRequested: true, split: "review_requested" });

describe("activityOf: what changed between two polls", () => {
  it("says nothing on the first poll: the digest sums that one up", () => {
    expect(activityOf(snap([], null), snap([theirs(1)]), AT)).toEqual([]);
  });

  it("a review newly asked of you, never on your own PR", () => {
    const got = activityOf(snap([]), snap([theirs(1), pr(2, { reviewRequested: true })]), AT);
    expect(got).toEqual([{ kind: "review_requested", repo: "o/a", number: 1, title: "PR 1", url: "https://github.com/o/a/pull/1", at: AT }]);
    expect(activityOf(snap([theirs(1)]), snap([theirs(1)]), AT)).toEqual([]);
  });

  it("your PR's checks turning red, and back to green when it is not ready to merge yet", () => {
    expect(activityOf(snap([pr(3)]), snap([pr(3, { checks: red, split: "ci_failed" })]), AT).map((a) => a.kind)).toEqual(["checks_failed"]);
    expect(activityOf(snap([pr(3, { checks: red, split: "ci_failed" })]), snap([pr(3, { checks: green, split: "mine" })]), AT).map((a) => a.kind)).toEqual(["checks_passed"]);
  });

  it("ready to merge says so once, in place of checks passing", () => {
    const got = activityOf(snap([pr(4, { checks: red, split: "ci_failed" })]), snap([pr(4, { checks: green, split: "ready_to_merge" })]), AT);
    expect(got.map((a) => a.kind)).toEqual(["ready_to_merge"]);
    expect(activityOf(snap([pr(4, { split: "ready_to_merge" })]), snap([pr(4, { split: "ready_to_merge" })]), AT)).toEqual([]);
  });

  it("changes newly requested on your PR; a PR first seen now raises nothing but a review", () => {
    expect(activityOf(snap([pr(5)]), snap([pr(5, { reviewDecision: "CHANGES_REQUESTED", split: "changes_requested" })]), AT).map((a) => a.kind)).toEqual(["changes_requested"]);
    expect(activityOf(snap([]), snap([pr(6, { checks: red, split: "ci_failed" })]), AT)).toEqual([]);
  });
});

describe("digestOf: one line of what waits on you", () => {
  it("counts reviews, red checks and ready merges, and is null when nothing waits", () => {
    expect(digestOf(snap([theirs(1), theirs(2), pr(3, { checks: red, split: "ci_failed" }), pr(4, { split: "ready_to_merge" })]))).toBe(
      "2 PRs are waiting for your review · 1 of your PRs has failing checks · 1 is ready to merge",
    );
    expect(digestOf(snap([pr(7)]))).toBeNull();
  });
});
