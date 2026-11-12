import { HOST_GIT } from "../adapters/git/worktree.ts";
import { mkdtempSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PrSnapshot } from "@hardness/contracts";
import { describe, expect, it, vi } from "vitest";

import { fakeGitHub } from "../test/github.ts";
import { PrBusyError } from "./pr-tasks.ts";
import { CloneError, GitHubPulls, NoPullError, NotReadyError } from "./pulls.ts";

/** A PR node as PR_QUERY answers it, approved and green unless overridden. */
function node(number: number, over: Record<string, unknown> = {}) {
  return {
    number,
    title: `PR ${number}`,
    url: `https://github.com/o/a/pull/${number}`,
    isDraft: false,
    updatedAt: "2026-10-27T10:00:00Z",
    baseRefName: "main",
    headRefName: `feat/${number}`,
    author: { login: "me" },
    headRepository: { nameWithOwner: "o/a" },
    reviewDecision: "APPROVED",
    mergeable: "MERGEABLE",
    reviewRequests: { nodes: [] },
    reviewThreads: { nodes: [] },
    commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS", contexts: { nodes: [{ __typename: "CheckRun", name: "build", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: null }] } } } }] },
    ...over,
  };
}

interface World {
  hits: Array<{ number: number; repository: { nameWithOwner: string }; updatedAt: string }>;
  nodes: Record<number, Record<string, unknown> | null>;
  searchError?: string;
  /** A PR whose `prFacts` call rejects with this message, by number. */
  factsErrors?: Record<number, string>;
  /** Every open PR in the repos the token reaches (the all-list), as `listOpenPrs` answers. */
  reachable?: Array<{ number: number; repository: { nameWithOwner: string }; updatedAt: string }>;
  capped?: Array<{ repo: string; open: number }>;
  reachableError?: string;
  mergeError?: string;
  cloneError?: string;
  /** When set, every `prFacts` call takes a few ms and this records how many ran at once. */
  flight?: { now: number; max: number };
}

function setup(world: World, over: Partial<ConstructorParameters<typeof GitHubPulls>[0]> = {}) {
  const calls: string[][] = [];
  const github = fakeGitHub({
    viewer: async () => ({ login: "me", teams: [] }),
    searchMyPrs: async () => {
      if (world.searchError) throw new Error(world.searchError);
      return world.hits.map((h) => ({ repo: h.repository.nameWithOwner, number: h.number, updatedAt: h.updatedAt }));
    },
    listOpenPrs: async () => {
      if (world.reachableError) throw new Error(world.reachableError);
      return { hits: (world.reachable ?? []).map((h) => ({ repo: h.repository.nameWithOwner, number: h.number, updatedAt: h.updatedAt })), capped: world.capped ?? [] };
    },
    prFacts: async (repo, number) => {
      calls.push(["facts", repo, String(number)]);
      if (world.flight) {
        world.flight.max = Math.max(world.flight.max, ++world.flight.now);
        await new Promise((resolve) => setTimeout(resolve, 5));
        world.flight.now--;
      }
      if (world.factsErrors?.[number]) throw new Error(world.factsErrors[number]);
      return (world.nodes[number] ?? null) as never;
    },
    closePr: async (repo, number) => void calls.push(["close", repo, String(number)]),
    mergePr: async (repo, number) => {
      calls.push(["merge", repo, String(number)]);
      if (world.mergeError) throw new Error(world.mergeError);
      return { merged: true as const, sha: null };
    },
  });
  const exec = async (command: string, args: string[]) => {
    calls.push([command, ...args]);
    return world.cloneError ? { code: 1, stdout: "", stderr: world.cloneError } : { code: 0, stdout: "", stderr: "" };
  };
  const published: PrSnapshot[] = [];
  const publishedAll: PrSnapshot[] = [];
  const remembered: Array<[string, string]> = [];
  const pulls = new GitHubPulls({
    github,
    exec,
    intervalMs: 60_000,
    allIntervalMs: 600_000,
    resolveRepo: async (repo) => (repo === "o/a" ? "/r/a" : null),
    rememberRepo: (repo, path) => void remembered.push([repo, path]),
    findTask: async (_repo, number) => (number === 2 ? { id: "t2", state: "ci_watch", route: "ci_fix" } : null),
    publish: (snapshot) => void published.push(snapshot),
    publishAll: (snapshot) => void publishedAll.push(snapshot),
    ...over,
  });
  return { pulls, calls, published, publishedAll, remembered };
}

const hit = (number: number, repo = "o/a") => ({ number, repository: { nameWithOwner: repo }, updatedAt: "2026-10-27T10:00:00Z" });

describe("GitHubPulls.pollOnce", () => {
  it("builds the snapshot with each PR's split, checkout and task, and publishes only when it changed", async () => {
    const { pulls, published } = setup({ hits: [hit(1), hit(2), hit(3, "o/b")], nodes: { 1: node(1), 2: node(2, { reviewDecision: "REVIEW_REQUIRED" }), 3: node(3, { headRepository: { nameWithOwner: "o/b" } }) } });
    const snapshot = await pulls.pollOnce();
    expect(snapshot.error).toBeNull();
    expect(snapshot.polledAt).not.toBeNull();
    expect(snapshot.prs.map((p) => [p.repo, p.number, p.split, p.localPath, p.task?.id ?? null])).toEqual([
      ["o/a", 1, "ready_to_merge", "/r/a", null],
      ["o/a", 2, "mine", "/r/a", "t2"],
      ["o/b", 3, "ready_to_merge", null, null],
    ]);
    expect(published).toHaveLength(1);
    await pulls.pollOnce();
    expect(published).toHaveLength(1);
    expect(pulls.snapshot.prs).toHaveLength(3);
  });

  it("fetches the PRs side by side, a few at a time, and keeps GitHub's order", async () => {
    const numbers = Array.from({ length: 14 }, (_, i) => i + 1);
    const world: World = { hits: numbers.map((n) => hit(n)), nodes: Object.fromEntries(numbers.map((n) => [n, node(n)])), flight: { now: 0, max: 0 } };
    const { pulls } = setup(world);
    const snapshot = await pulls.pollOnce();
    expect(snapshot.prs.map((p) => p.number)).toEqual(numbers);
    expect(world.flight!.max).toBeGreaterThan(1);
    expect(world.flight!.max).toBeLessThanOrEqual(6);
  });

  it("drops a PR GitHub no longer shows and keeps going when one PR's facts fail", async () => {
    const world: World = { hits: [hit(1), hit(2)], nodes: { 1: node(1), 2: null } };
    const { pulls } = setup(world);
    expect((await pulls.pollOnce()).prs.map((p) => p.number)).toEqual([1]);
  });

  it("puts a failed search in the snapshot's error, keeps the last list, and never throws", async () => {
    const world: World = { hits: [hit(1)], nodes: { 1: node(1) } };
    const { pulls, published } = setup(world);
    await pulls.pollOnce();
    world.searchError = "searching pull requests failed (401): Bad credentials";
    const snapshot = await pulls.pollOnce();
    expect(snapshot.error).toMatch(/Bad credentials/);
    expect(snapshot.prs).toHaveLength(1);
    expect(published).toHaveLength(2);
  });

  it("keeps the last list, says why and backs off when the PRs' facts are rate limited, instead of publishing an empty inbox", async () => {
    const world: World = { hits: [hit(1), hit(2)], nodes: { 1: node(1), 2: node(2) } };
    const { pulls } = setup(world);
    await pulls.pollOnce();
    world.factsErrors = { 1: "API rate limit exceeded (RATE_LIMITED)", 2: "API rate limit exceeded (RATE_LIMITED)" };
    // Both PRs moved on, so their cached facts no longer stand and GitHub is asked again.
    world.hits = world.hits.map((h) => ({ ...h, updatedAt: "2026-10-28T10:00:00Z" }));
    const snapshot = await pulls.pollOnce();
    expect(snapshot.error).toMatch(/rate limit/i);
    expect(snapshot.prs.map((p) => p.number)).toEqual([1, 2]);
    expect(pulls.nextDelayMs).toBe(5 * 60_000);
  });

  it("still drops only the PR whose facts fail for another reason", async () => {
    const world: World = { hits: [hit(1), hit(2)], nodes: { 1: node(1), 2: node(2) }, factsErrors: { 2: "boom (500)" } };
    const { pulls } = setup(world);
    const snapshot = await pulls.pollOnce();
    expect(snapshot.error).toBeNull();
    expect(snapshot.prs.map((p) => p.number)).toEqual([1]);
  });

  it("backs off to five minutes after a rate limit answer and returns to the interval after a good poll", async () => {
    const world: World = { hits: [hit(1)], nodes: { 1: node(1) }, searchError: "API rate limit exceeded (RATE_LIMITED)" };
    const { pulls } = setup(world);
    await pulls.pollOnce();
    expect(pulls.nextDelayMs).toBe(5 * 60_000);
    world.searchError = undefined;
    await pulls.pollOnce();
    expect(pulls.nextDelayMs).toBe(60_000);
  });
});

const factsCalls = (calls: string[][]) => calls.filter((c) => c[0] === "facts").map((c) => `${c[1]}#${c[2]}`);

describe("GitHubPulls.pollAllOnce", () => {
  const world = (): World => ({
    hits: [hit(1)],
    reachable: [hit(1), hit(4, "o/a"), hit(5, "o/b")],
    nodes: { 1: node(1), 4: node(4, { author: { login: "them" }, reviewDecision: "REVIEW_REQUIRED" }), 5: node(5, { author: { login: "them" }, headRepository: { nameWithOwner: "o/b" } }) },
  });

  it("builds a second snapshot of every open PR in your repos with the inbox's split, checkout and task, and publishes it on its own", async () => {
    const { pulls, published, publishedAll } = setup(world());
    const snapshot = await pulls.pollAllOnce();
    expect(snapshot.error).toBeNull();
    expect(snapshot.polledAt).not.toBeNull();
    expect(snapshot.prs.map((p) => [p.repo, p.number, p.mine, p.split, p.localPath])).toEqual([
      ["o/a", 1, true, "ready_to_merge", "/r/a"],
      ["o/a", 4, false, "mine", "/r/a"],
      ["o/b", 5, false, "mine", null],
    ]);
    expect(pulls.all).toBe(snapshot);
    expect(pulls.snapshot.prs).toEqual([]);
    expect(publishedAll).toHaveLength(1);
    expect(published).toHaveLength(0);
    await pulls.pollAllOnce();
    expect(publishedAll).toHaveLength(1);
  });

  it("does not fetch a PR again while its updatedAt is the same, and shares what the inbox fetched", async () => {
    const w = world();
    const { pulls, calls } = setup(w);
    await pulls.pollOnce();
    await pulls.pollAllOnce();
    await pulls.pollAllOnce();
    await pulls.pollOnce();
    expect(factsCalls(calls).sort()).toEqual(["o/a#1", "o/a#4", "o/b#5"]);
    // A PR that moved on is read again, and only that one.
    w.reachable = w.reachable!.map((h) => (h.number === 4 ? { ...h, updatedAt: "2026-10-28T10:00:00Z" } : h));
    await pulls.pollAllOnce();
    expect(factsCalls(calls).sort()).toEqual(["o/a#1", "o/a#4", "o/a#4", "o/b#5"]);
  });

  it("reads a PR again while its checks run or GitHub has not said whether it merges, since neither bumps updatedAt", async () => {
    const running = { commits: { nodes: [{ commit: { statusCheckRollup: { state: "PENDING", contexts: { nodes: [{ __typename: "CheckRun", name: "build", status: "IN_PROGRESS", conclusion: null, detailsUrl: null }] } } } }] } };
    const w: World = { hits: [hit(1), hit(2)], reachable: [hit(1), hit(2)], nodes: { 1: node(1, running), 2: node(2, { mergeable: "UNKNOWN" }) } };
    const { pulls, calls } = setup(w);
    await pulls.pollOnce();
    await pulls.pollAllOnce();
    expect(factsCalls(calls)).toEqual(["o/a#1", "o/a#2", "o/a#1", "o/a#2"]);
  });

  it("keeps the last list, says why and backs off five minutes when GitHub refuses, then returns to its own interval", async () => {
    const w = world();
    const { pulls, publishedAll } = setup(w);
    await pulls.pollAllOnce();
    expect(pulls.allNextDelayMs).toBe(600_000);
    w.reachableError = "listing the open PRs of your repositories failed (403): API rate limit exceeded";
    const snapshot = await pulls.pollAllOnce();
    expect(snapshot.error).toMatch(/rate limit/i);
    expect(snapshot.prs).toHaveLength(3);
    expect(pulls.allNextDelayMs).toBe(5 * 60_000);
    expect(publishedAll).toHaveLength(2);
    w.reachableError = undefined;
    expect((await pulls.pollAllOnce()).error).toBeNull();
    expect(pulls.allNextDelayMs).toBe(600_000);
  });

  it("backs off when the PRs' facts are rate limited, instead of publishing an empty list", async () => {
    const w = world();
    const { pulls } = setup(w);
    await pulls.pollAllOnce();
    w.factsErrors = { 4: "API rate limit exceeded (RATE_LIMITED)" };
    w.reachable = w.reachable!.map((h) => ({ ...h, updatedAt: "2026-10-29T10:00:00Z" }));
    const snapshot = await pulls.pollAllOnce();
    expect(snapshot.error).toMatch(/rate limit/i);
    expect(snapshot.prs).toHaveLength(3);
    expect(pulls.allNextDelayMs).toBe(5 * 60_000);
  });

  it("logs a repo with more open PRs than one query reads instead of capping silently", async () => {
    const w = world();
    w.capped = [{ repo: "o/big", open: 130 }];
    const { pulls } = setup(w);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await pulls.pollAllOnce();
      expect(warn.mock.calls.flat().join(" ")).toMatch(/o\/big.*130/);
    } finally {
      warn.mockRestore();
    }
  });

  it("resolves a repo cloned later in both lists without asking GitHub again", async () => {
    const dest = join(mkdtempSync(join(tmpdir(), "pulls-all-clone-")), "b");
    const w: World = { hits: [hit(5, "o/b")], reachable: [hit(5, "o/b")], nodes: { 5: node(5, { headRepository: { nameWithOwner: "o/b" } }) } };
    const resolved = new Map<string, string>();
    const { pulls, calls } = setup(w, { resolveRepo: async (repo) => resolved.get(repo) ?? null, rememberRepo: (repo, path) => void resolved.set(repo, path) });
    await pulls.pollOnce();
    await pulls.pollAllOnce();
    expect(pulls.snapshot.prs[0]?.localPath).toBeNull();
    expect(pulls.all.prs[0]?.localPath).toBeNull();
    await pulls.clone("o/b", dest);
    await pulls.cloning;
    expect(pulls.snapshot.prs[0]?.localPath).toBe(dest);
    expect(pulls.all.prs[0]?.localPath).toBe(dest);
    expect(factsCalls(calls)).toEqual(["o/b#5"]);
  });
});

describe("GitHubPulls.merge", () => {
  it("refuses a PR outside Ready to merge, squashes a ready one, and polls again", async () => {
    const world: World = { hits: [hit(1), hit(2)], nodes: { 1: node(1), 2: node(2, { reviewDecision: "REVIEW_REQUIRED" }) } };
    const { pulls, calls } = setup(world);
    await pulls.pollOnce();
    await expect(pulls.merge("o/a", 2)).rejects.toThrow(NotReadyError);
    await expect(pulls.merge("o/a", 9)).rejects.toThrow(NotReadyError);
    world.hits = [hit(2)];
    await pulls.merge("o/a", 1);
    expect(calls).toContainEqual(["merge", "o/a", "1"]);
    expect(pulls.snapshot.prs.map((p) => p.number)).toEqual([2]);
  });

  it("surfaces gh's merge error", async () => {
    const world: World = { hits: [hit(1)], nodes: { 1: node(1) }, mergeError: "Pull request is not mergeable" };
    const { pulls } = setup(world);
    await pulls.pollOnce();
    await expect(pulls.merge("o/a", 1)).rejects.toThrow(/not mergeable/);
  });
});

describe("GitHubPulls.close", () => {
  it("closes any PR in the snapshot, polls again, and refuses a PR a task works on or one it does not know", async () => {
    const world: World = { hits: [hit(1), hit(2)], nodes: { 1: node(1, { reviewDecision: "REVIEW_REQUIRED" }), 2: node(2) } };
    const { pulls, calls } = setup(world);
    await pulls.pollOnce();
    await pulls.close("o/a", 1);
    expect(calls).toContainEqual(["close", "o/a", "1"]);
    await expect(pulls.close("o/a", 9)).rejects.toThrow(NoPullError);
    const busy = setup(world, { findTask: async () => ({ id: "t1234567", state: "implementing", route: "ci_fix" }) });
    await busy.pulls.pollOnce();
    await expect(busy.pulls.close("o/a", 1)).rejects.toThrow(PrBusyError);
    expect(busy.calls.some((c) => c[0] === "close")).toBe(false);
  });
});

describe("GitHubPulls.clone", () => {
  const root = mkdtempSync(join(tmpdir(), "pulls-clone-"));

  it("refuses a relative destination, a missing parent and an existing folder that is no checkout", async () => {
    const { pulls } = setup({ hits: [], nodes: {} });
    await expect(pulls.clone("o/b", "relative/b")).rejects.toThrow(CloneError);
    await expect(pulls.clone("o/b", join(root, "nope", "b"))).rejects.toThrow(CloneError);
    mkdirSync(join(root, "taken"));
    const notGit = async () => ({ code: 128, stdout: "", stderr: "not a git repository" });
    const { pulls: strict } = setup({ hits: [], nodes: {} }, { exec: notGit });
    await expect(strict.clone("o/b", join(root, "taken"))).rejects.toThrow(/not a git checkout/);
  });

  it("links a folder that already is a checkout instead of cloning over it", async () => {
    const dest = join(root, "workbench");
    mkdirSync(dest);
    const world: World = { hits: [hit(3, "o/workbench")], nodes: { 3: node(3, { headRepository: { nameWithOwner: "o/workbench" } }) } };
    const resolved = new Map<string, string>();
    const calls: string[][] = [];
    const exec = async (command: string, args: string[]) => {
      calls.push([command, ...args]);
      return { code: 0, stdout: `${realpathSync(dest)}\n`, stderr: "" };
    };
    const { pulls } = setup(world, { exec, resolveRepo: async (repo) => resolved.get(repo) ?? null, rememberRepo: (repo, path) => void resolved.set(repo, path) });
    await pulls.pollOnce();
    expect(pulls.snapshot.prs[0]?.localPath).toBeNull();
    await pulls.clone("o/workbench", dest);
    await pulls.cloning;
    expect(calls.some((c) => c.includes("clone"))).toBe(false);
    expect(resolved.get("o/workbench")).toBe(dest);
    expect(pulls.snapshot.prs[0]?.localPath).toBe(dest);
  });

  it("clones in the background, remembers the path and polls again once done", async () => {
    const world: World = { hits: [hit(3, "o/b")], nodes: { 3: node(3, { headRepository: { nameWithOwner: "o/b" } }) } };
    const resolved = new Map<string, string>([["o/a", "/r/a"]]);
    const { pulls, calls, remembered } = setup(world, {
      resolveRepo: async (repo) => resolved.get(repo) ?? null,
      rememberRepo: (repo, path) => void resolved.set(repo, path),
    });
    await pulls.pollOnce();
    expect(pulls.snapshot.prs[0]?.localPath).toBeNull();
    const dest = join(root, "b");
    await pulls.clone("o/b", dest);
    await pulls.cloning;
    expect(calls).toContainEqual(["git", ...HOST_GIT, "clone", "https://github.com/o/b.git", dest]);
    expect(remembered).toEqual([]);
    expect(resolved.get("o/b")).toBe(dest);
    expect(pulls.snapshot.prs[0]?.localPath).toBe(dest);
  });

  it("reports a failed clone in the snapshot's error", async () => {
    const world: World = { hits: [], nodes: {}, cloneError: "repository not found" };
    const { pulls } = setup(world);
    await pulls.clone("o/c", join(root, "c"));
    await pulls.cloning;
    expect(pulls.snapshot.error).toMatch(/clone.*not found/);
  });
});
