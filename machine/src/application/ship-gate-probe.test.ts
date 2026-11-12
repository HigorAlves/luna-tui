import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { DEFAULT_POLICY } from "../domain/policy.ts";
import type { ApprovalRow, TaskRow } from "../domain/task.ts";
import { fakeGitHub } from "../test/github.ts";
import { emptyCursor, saveCursor } from "./ship-cursor.ts";
import { shipGateProbe } from "./ship-gate-probe.ts";

const HEAD = "a".repeat(40);
const MOVED = "d".repeat(40);
const open = { merged: false, mergedSha: null, state: "open" as const, mergedAt: null };
const node = (checks = "SUCCESS", oid = HEAD) => ({
  id: "PR_1", number: 3, title: "t", body: null, url: "https://github.com/a/b/pull/3", isDraft: false, updatedAt: "2026-11-04T11:00:00Z", baseRefName: "main", headRefName: "hardness/t1",
  author: { login: "me" }, headRepository: { nameWithOwner: "a/b" }, reviewDecision: "APPROVED", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewRequests: { nodes: [] }, reviewThreads: { nodes: [] },
  commits: { nodes: [{ commit: { oid, committedDate: new Date().toISOString(), statusCheckRollup: { state: checks, contexts: { nodes: [{ __typename: "CheckRun", name: "build", status: "COMPLETED", conclusion: checks, detailsUrl: null }] } } } }] },
});
const pack = { summary: "s", format: "text", scenarios: [], findings: [], outOfMap: [], risk: "high", rollback: "r", howToVerify: "h", commitSha: HEAD, media: [], at: "2026-11-04T00:00:00.000Z" };
const task = { id: "t1", repoPath: "/repo", branch: "hardness/t1" } as unknown as TaskRow;
const gate = (head = HEAD) => ({ kind: "awaiting_ship", decision: null, requested: { gate: "ship_approval", head } }) as unknown as ApprovalRow;

async function probeWith(github: Parameters<typeof fakeGitHub>[0], withCursor = true, stack?: { facts: () => Promise<null>; defaultBranch: () => Promise<string | null> }) {
  const stateDir = await mkdtemp(join(tmpdir(), "probe-"));
  if (withCursor) await saveCursor(stateDir, "t1", emptyCursor({ slug: "a/b", number: 3 }));
  const gh = fakeGitHub({ viewer: async () => ({ login: "me", teams: [] }), reviewRule: async () => ({ source: "ruleset" as const, approvals: 1, codeOwners: false }), prReviews: async () => [], prFiles: async () => [], fileAtRef: async () => null, prHeadSha: async () => HEAD, prMerged: async () => open, prFacts: async () => node() as never, ...github });
  return shipGateProbe({ github: gh, policies: { for: async () => DEFAULT_POLICY }, evidence: { load: async () => pack as never }, stateDir, ...(stack ? { stack } : {}) });
}

describe("shipGateProbe", () => {
  it("keeps a gate whose head is the head and whose checklist still passes", async () => {
    expect(await (await probeWith({}))(task, gate())).toBe("keep");
  });
  it("says merged for a PR GitHub shows merged", async () => {
    expect(await (await probeWith({ prMerged: async () => ({ ...open, merged: true, state: "closed" as const, mergedSha: "m" }) }))(task, gate())).toBe("merged");
  });
  it("says closed, never merged, for a PR merged into a branch that is not the default", async () => {
    const merged = { ...open, merged: true, state: "closed" as const, mergedSha: "m" };
    const stack = { facts: async () => null, defaultBranch: async () => "main" };
    expect(await (await probeWith({ prMerged: async () => merged, prFacts: async () => ({ ...node(), baseRefName: "task/parent" }) as never }, true, stack))(task, gate())).toBe("closed");
    expect(await (await probeWith({ prMerged: async () => merged, prFacts: async () => node() as never }, true, stack))(task, gate())).toBe("merged");
  });
  it("says closed for a PR GitHub shows closed and not merged", async () => {
    expect(await (await probeWith({ prMerged: async () => ({ ...open, state: "closed" as const }) }))(task, gate())).toBe("closed");
  });
  it("withdraws when the head moved", async () => {
    expect(await (await probeWith({ prFacts: async () => node("SUCCESS", MOVED) as never, prHeadSha: async () => MOVED }))(task, gate())).toBe("withdraw");
  });
  it("withdraws when the checklist no longer passes", async () => {
    expect(await (await probeWith({ prFacts: async () => node("FAILURE") as never }))(task, gate())).toBe("withdraw");
  });
  it("withdraws an open ship approval when a collaborator's objection lands, whatever GitHub's review decision says", async () => {
    const ana = { author: "ana", state: "APPROVED", commitId: HEAD, at: "t", association: "COLLABORATOR" };
    const bob = { author: "bob", state: "CHANGES_REQUESTED", commitId: HEAD, at: "t2", association: "COLLABORATOR" };
    expect(await (await probeWith({ prReviews: async () => [ana, bob] }))(task, gate())).toBe("withdraw");
  });
  const review = (author: string, state: string, commitId = HEAD, association = "COLLABORATOR") => ({ author, state, commitId, at: "t", association });
  it("reports who approved the PR on the head: a collaborator's approval is the release approval", async () => {
    expect(await (await probeWith({ prReviews: async () => [review("ana", "APPROVED")] }))(task, gate())).toEqual({ approvedBy: ["ana"], head: HEAD });
    expect(await (await probeWith({ prReviews: async () => [review("ana", "APPROVED"), review("Cy", "APPROVED", HEAD, "OWNER")] }))(task, gate())).toEqual({ approvedBy: ["ana", "Cy"], head: HEAD });
  });
  it("does not count an approval on an older head, from a stranger, from the machine's own login, or one the same person took back", async () => {
    for (const reviews of [
      [review("ana", "APPROVED", MOVED)],
      [review("ana", "APPROVED", HEAD, "NONE")],
      [review("ana", "APPROVED", HEAD, "CONTRIBUTOR")],
      [review("me", "APPROVED")],
      [review("ana", "COMMENTED")],
    ]) expect(await (await probeWith({ prReviews: async () => reviews }))(task, gate())).toBe("keep");
    expect(await (await probeWith({ prReviews: async () => [review("ana", "APPROVED"), review("ana", "CHANGES_REQUESTED")] }))(task, gate())).toBe("withdraw");
    expect(await (await probeWith({ prReviews: async () => [review("ana", "APPROVED"), review("ana", "DISMISSED")] }))(task, gate())).toBe("keep");
  });
  it("a merged PR is merged, whatever the reviews say", async () => {
    const merged = { ...open, merged: true, state: "closed" as const, mergedSha: "m" };
    expect(await (await probeWith({ prMerged: async () => merged, prReviews: async () => [review("ana", "APPROVED")] }))(task, gate())).toBe("merged");
  });
  it("keeps when there is no cursor or GitHub shows no PR: nothing is withdrawn on a guess", async () => {
    expect(await (await probeWith({}, false))(task, gate())).toBe("keep");
    expect(await (await probeWith({ prFacts: async () => null }))(task, gate())).toBe("keep");
  });

  describe("a /ship comment", () => {
    // The head commit of `node()` is dated when the test runs, so "after" is the far future and "before" the far past.
    const AFTER = "2099-01-01T00:00:00Z";
    const BEFORE = "2000-01-01T00:00:00Z";
    const said = (actor: string | null, body: string, at = AFTER, association: string | null = "COLLABORATOR", kind: "comment" | "review_comment" | "review" = "comment") => ({ id: `comment:${actor}${body}${at}`, kind, actor, isBot: false, body, association, state: null, at, url: null });
    const withComments = (comments: ReturnType<typeof said>[]) => ({ prActivity: async () => comments });
    it("counts for the token's own login, which GitHub never lets review its own PR", async () => {
      expect(await (await probeWith(withComments([said("me", "/ship")])))(task, gate())).toEqual({ approvedBy: ["me"], head: HEAD, byComment: ["me"] });
    });
    it("is read case-insensitively and trimmed", async () => {
      expect(await (await probeWith(withComments([said("ana", "  /SHIP \n")])))(task, gate())).toEqual({ approvedBy: ["ana"], head: HEAD, byComment: ["ana"] });
    });
    it("follows the reviews in the list, and a person who did both is a review", async () => {
      const github = { ...withComments([said("me", "/ship"), said("ana", "/ship")]), prReviews: async () => [review("ana", "APPROVED")] };
      expect(await (await probeWith(github))(task, gate())).toEqual({ approvedBy: ["ana", "me"], head: HEAD, byComment: ["me"] });
    });
    it("does not count before the head commit, before the question was asked, from a stranger, or with any other body", async () => {
      for (const comments of [
        [said("me", "/ship", BEFORE)],
        [said("ana", "/ship", AFTER, "NONE")],
        [said("ana", "/ship", AFTER, "CONTRIBUTOR")],
        [said("ana", "/ship it")],
        [said("ana", "LGTM")],
        [said("ana", "/ship", AFTER, "COLLABORATOR", "review_comment")],
        [said(null, "/ship")],
      ]) expect(await (await probeWith(withComments(comments)))(task, gate())).toBe("keep");
      const asked = { ...gate(), createdAt: new Date("2099-06-01T00:00:00Z") } as ApprovalRow;
      expect(await (await probeWith(withComments([said("me", "/ship")])))(task, asked)).toBe("keep");
      expect(await (await probeWith(withComments([said("me", "/ship", "2099-07-01T00:00:00Z")])))(task, asked)).toEqual({ approvedBy: ["me"], head: HEAD, byComment: ["me"] });
    });
    it("does not count for a head that moved, a checklist that fails, or a later objection", async () => {
      expect(await (await probeWith({ ...withComments([said("me", "/ship")]), prFacts: async () => node("SUCCESS", MOVED) as never, prHeadSha: async () => MOVED }))(task, gate())).toBe("withdraw");
      expect(await (await probeWith({ ...withComments([said("me", "/ship")]), prFacts: async () => node("FAILURE") as never }))(task, gate())).toBe("withdraw");
      expect(await (await probeWith({ ...withComments([said("me", "/ship")]), prReviews: async () => [review("bob", "CHANGES_REQUESTED")] }))(task, gate())).toBe("withdraw");
    });
    it("leaves the gate when the comments cannot be read", async () => {
      expect(await (await probeWith({ prActivity: async () => Promise.reject(new Error("github down")) }))(task, gate())).toBe("keep");
    });
    it("is not looked for once the PR is merged", async () => {
      const merged = { ...open, merged: true, state: "closed" as const, mergedSha: "m" };
      expect(await (await probeWith({ prMerged: async () => merged, ...withComments([said("me", "/ship")]) }))(task, gate())).toBe("merged");
    });
  });
});
