import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { TaskRow } from "../../domain/task.ts";
import { fakeGitHub } from "../../test/github.ts";
import type { StageContext } from "../ports.ts";
import { emptyCursor, loadCursor, saveCursor } from "../ship-cursor.ts";
import { MERGE_QUEUE_WAIT_MS, mergeRunner } from "./ship.ts";
import type { ShipFacts } from "./ship-monitor.ts";

const HEAD = "a".repeat(40);
const MERGE_COMMIT = "b".repeat(40);
const open = { merged: false, mergedSha: null, state: "open" as const, mergedAt: null };
const context = { task: { id: "t1", title: "feat", description: "d", criteria: [], branch: "hardness/t1", worktreePath: "/wt", repoPath: "/repo", source: null } as unknown as TaskRow, stage: "shipping", attempt: 1, runId: "r1", approvals: [], signal: new AbortController().signal } as StageContext;
const facts = (canAutoMerge: boolean, head = HEAD, reason = "not ready: CI is red"): ShipFacts => ({ pr: {} as ShipFacts["pr"], head, pack: null, risk: "low", paths: [], releaseOwners: [], readiness: { ready: canAutoMerge, canAutoMerge, blockers: canAutoMerge ? [] : [reason], reason, checklist: [] } as unknown as ShipFacts["readiness"] });

async function wire(over: { github?: Parameters<typeof fakeGitHub>[0]; facts?: () => Promise<ShipFacts | null>; cursor?: boolean } = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), "merge-"));
  if (over.cursor !== false) await saveCursor(stateDir, "t1", emptyCursor({ slug: "a/b", number: 3 }));
  const github = fakeGitHub({ prMerged: async () => open, mergePr: async () => undefined, ...over.github });
  const settle = vi.fn(async () => {});
  const sleep = vi.fn(async () => {});
  const run = mergeRunner({ github, policies: { for: async () => ({}) as never }, evidence: { load: async () => null }, stateDir, pollMs: 1000, sleep, readFacts: over.facts ?? (async () => facts(true)), settle });
  return { run, github, stateDir, settle, sleep };
}

describe("mergeRunner (shipping)", () => {
  it("records the merge commit GitHub reports, never the PR head, and guards the merge with the head's sha", async () => {
    let merged = false;
    const { run, github, settle } = await wire({ github: { mergePr: async () => { merged = true; }, prMerged: async () => (merged ? { merged: true, mergedSha: MERGE_COMMIT, state: "closed", mergedAt: "2026-11-06T10:00:00Z" } : open) } });
    const result = await run(context);
    expect(result).toMatchObject({ outcome: "pass", detail: { merged: { sha: MERGE_COMMIT, by: "machine" }, number: 3 } });
    expect(MERGE_COMMIT).not.toBe(HEAD);
    expect(github.mergePr).toHaveBeenCalledWith("a/b", 3, { sha: HEAD });
    expect(settle).toHaveBeenCalledTimes(1);
  });

  it("records a PR a person merged first without merging again", async () => {
    const { run, github } = await wire({ github: { prMerged: async () => ({ merged: true, mergedSha: MERGE_COMMIT, state: "closed", mergedAt: "t" }) } });
    expect(await run(context)).toMatchObject({ outcome: "pass", detail: { merged: { sha: MERGE_COMMIT, by: "person" } } });
    expect(github.mergePr).not.toHaveBeenCalled();
  });

  it("is not ready when readiness is read again and no longer passes: it fails with notReady and merges nothing", async () => {
    const { run, github } = await wire({ facts: async () => facts(false) });
    expect(await run(context)).toEqual({ outcome: "fail", detail: { notReady: true, reason: "not ready: CI is red" } });
    expect(github.mergePr).not.toHaveBeenCalled();
  });

  it("is not ready when GitHub shows no PR, and when there is no cursor", async () => {
    const none = await wire({ facts: async () => null });
    expect(await none.run(context)).toMatchObject({ outcome: "fail", detail: { notReady: true } });
    const noCursor = await wire({ cursor: false });
    expect(await noCursor.run(context)).toMatchObject({ outcome: "fail", detail: { notReady: true } });
    expect(noCursor.github.mergePr).not.toHaveBeenCalled();
  });

  it("records no sha, with a note, when GitHub names no merge commit after three reads", async () => {
    let merged = false;
    const { run, github } = await wire({ github: { mergePr: async () => { merged = true; }, prMerged: async () => (merged ? { merged: true, mergedSha: null, state: "closed", mergedAt: null } : open) } });
    const result = await run(context);
    expect(result).toMatchObject({ outcome: "pass", detail: { merged: { sha: null } } });
    expect(String(result.detail?.note)).toMatch(/merge commit/);
    // one read before the merge, three after
    expect(github.prMerged).toHaveBeenCalledTimes(4);
  });

  it("escalates once a merge has failed twice, resuming at shipping", async () => {
    const { run, github } = await wire({ github: { mergePr: async () => { throw new Error("405 not allowed"); } } });
    expect(await run(context)).toMatchObject({ outcome: "escalated", detail: { escalation: "other", reason: expect.stringContaining("failed twice") } });
    expect(github.mergePr).toHaveBeenCalledTimes(2);
  });

  it("queued: polls prMerged until the queue merges it, and keeps the queue's merge as the machine's", async () => {
    let polls = 0;
    const { run, stateDir, sleep } = await wire({ github: { mergePr: async () => ({ queued: true as const }), prMerged: async () => (++polls > 3 ? { merged: true, mergedSha: MERGE_COMMIT, state: "closed", mergedAt: "t" } : open) } });
    const result = await run(context);
    expect(result).toMatchObject({ outcome: "pass", detail: { merged: { sha: MERGE_COMMIT, by: "machine" } } });
    expect(sleep).toHaveBeenCalledWith(1000);
    expect((await loadCursor(stateDir, "t1"))?.queued).toBe(true);
  });

  it("queued: after six hours with no merge it clears the queue flag and answers notReady", async () => {
    let clock = 0;
    const stateDir = await mkdtemp(join(tmpdir(), "merge-"));
    await saveCursor(stateDir, "t1", { ...emptyCursor({ slug: "a/b", number: 3 }), queued: true });
    const github = fakeGitHub({ prMerged: async () => open });
    const run = mergeRunner({ github, policies: { for: async () => ({}) as never }, evidence: { load: async () => null }, stateDir, pollMs: 60_000, sleep: async (ms) => void (clock += ms), now: () => new Date(clock), readFacts: async () => facts(true), settle: async () => {} });
    expect(await run(context)).toMatchObject({ outcome: "fail", detail: { notReady: true } });
    expect(clock).toBeGreaterThanOrEqual(MERGE_QUEUE_WAIT_MS);
    expect((await loadCursor(stateDir, "t1"))?.queued).toBeFalsy();
    expect(github.mergePr).not.toHaveBeenCalled();
  });

  it("escalates a PR closed without a merge", async () => {
    const { run } = await wire({ github: { prMerged: async () => ({ merged: false, mergedSha: null, state: "closed", mergedAt: null }) } });
    expect(await run(context)).toMatchObject({ outcome: "escalated", detail: { reason: "the PR was closed without a merge" } });
  });

  it("a card restarted at shipping with the old monitor's cursor (a stored literal) finds the PR open and not ready, and hands it to the watch", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "merge-"));
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(join(stateDir, "tasks", "t1"), { recursive: true });
    await writeFile(join(stateDir, "tasks", "t1", "ship.json"), JSON.stringify({ schema: 1, pr: { slug: "a/b", number: 3 }, since: null, seen: [], threads: {}, fixRounds: 0, ciReruns: 0, rebases: 0, published: { sha: HEAD }, mergeRequested: true }));
    const github = fakeGitHub({ prMerged: async () => open });
    const run = mergeRunner({ github, policies: { for: async () => ({}) as never }, evidence: { load: async () => null }, stateDir, pollMs: 1, readFacts: async () => facts(false), settle: async () => {} });
    expect(await run(context)).toMatchObject({ outcome: "fail", detail: { notReady: true } });
    expect(github.mergePr).not.toHaveBeenCalled();
  });
});

describe("mergeRunner on a card that needed the release question", () => {
  const FRESH = "c".repeat(40);
  const node = {
    id: "PR_1", number: 3, title: "t", body: null, url: "https://github.com/a/b/pull/3", isDraft: false, updatedAt: "2026-11-04T11:00:00Z", baseRefName: "main", headRefName: "hardness/t1",
    author: { login: "me" }, headRepository: { nameWithOwner: "a/b" }, reviewDecision: "APPROVED", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewRequests: { nodes: [] }, reviewThreads: { nodes: [] },
    commits: { nodes: [{ commit: { oid: HEAD, committedDate: new Date().toISOString(), statusCheckRollup: { state: "SUCCESS", contexts: { nodes: [{ __typename: "CheckRun", name: "build", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: null }] } } } }] },
  };
  const pack = { summary: "s", format: "text", scenarios: [], findings: [], outOfMap: [], risk: "high", rollback: "r", howToVerify: "h", commitSha: HEAD, media: [], at: "2026-11-04T00:00:00.000Z" };
  const policy = { freeze: [], factory: { ship: { auto_merge: "medium_when_review_required", stale_days: 14, release_owners: [] } } };
  const approval = (head: string) => ({ kind: "awaiting_ship", decision: "approved", requested: { gate: "ship_approval", head }, response: { approver: "bo", head } }) as never;

  async function real(head: string) {
    const stateDir = await mkdtemp(join(tmpdir(), "merge-"));
    await saveCursor(stateDir, "t1", emptyCursor({ slug: "a/b", number: 3 }));
    let merged = false;
    const github = fakeGitHub({
      viewer: async () => ({ login: "me", teams: [] }),
      reviewRule: async () => ({ source: "ruleset" as const, approvals: 1, codeOwners: false }),
      prReviews: async () => [{ author: "ana", state: "APPROVED", commitId: HEAD, at: "t", association: "COLLABORATOR" }],
      prFacts: async () => node as never, prHeadSha: async () => HEAD, prFiles: async () => [], fileAtRef: async () => null,
      prMerged: async () => (merged ? { merged: true, mergedSha: MERGE_COMMIT, state: "closed", mergedAt: "t" } : open),
      mergePr: async () => { merged = true; },
    });
    const run = mergeRunner({ github, policies: { for: async () => policy as never }, evidence: { load: async () => pack as never }, stateDir, pollMs: 1000, sleep: async () => {}, settle: async () => {} });
    return { run: () => run({ ...context, approvals: [approval(head)] } as StageContext), github };
  }

  it("merges when the ship approval is for the head GitHub shows now, and an approval is on it", async () => {
    const { run, github } = await real(HEAD);
    expect(await run()).toMatchObject({ outcome: "pass", detail: { merged: { sha: MERGE_COMMIT } } });
    expect(github.mergePr).toHaveBeenCalledWith("a/b", 3, expect.objectContaining({ sha: HEAD }));
  });

  it("does not merge when the approval was for an older head: notReady, and the watch asks again", async () => {
    const { run, github } = await real(FRESH);
    expect(await run()).toMatchObject({ outcome: "fail", detail: { notReady: true } });
    expect(github.mergePr).not.toHaveBeenCalled();
  });
});
