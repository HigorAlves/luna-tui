import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PrSnapshot } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import { fakeGitHub } from "../test/github.ts";
import { CloneError, GitHubPulls, NotReadyError } from "./pulls.ts";

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
  mergeError?: string;
  cloneError?: string;
}

function setup(world: World, over: Partial<ConstructorParameters<typeof GitHubPulls>[0]> = {}) {
  const calls: string[][] = [];
  const github = fakeGitHub({
    viewer: async () => ({ login: "me", teams: [] }),
    searchMyPrs: async () => {
      if (world.searchError) throw new Error(world.searchError);
      return world.hits.map((h) => ({ repo: h.repository.nameWithOwner, number: h.number, updatedAt: h.updatedAt }));
    },
    prFacts: async (_repo, number) => (world.nodes[number] ?? null) as never,
    mergePr: async (repo, number) => {
      calls.push(["merge", repo, String(number)]);
      if (world.mergeError) throw new Error(world.mergeError);
    },
  });
  const exec = async (command: string, args: string[]) => {
    calls.push([command, ...args]);
    return world.cloneError ? { code: 1, stdout: "", stderr: world.cloneError } : { code: 0, stdout: "", stderr: "" };
  };
  const published: PrSnapshot[] = [];
  const remembered: Array<[string, string]> = [];
  const pulls = new GitHubPulls({
    github,
    exec,
    intervalMs: 60_000,
    resolveRepo: async (repo) => (repo === "o/a" ? "/r/a" : null),
    rememberRepo: (repo, path) => void remembered.push([repo, path]),
    findTask: async (_repo, number) => (number === 2 ? { id: "t2", state: "ci_watch", route: "ci_fix" } : null),
    publish: (snapshot) => void published.push(snapshot),
    ...over,
  });
  return { pulls, calls, published, remembered };
}

const hit = (number: number, repo = "o/a") => ({ number, repository: { nameWithOwner: repo }, updatedAt: "2026-10-27T10:00:00Z" });

describe("GitHubPulls.pollOnce", () => {
  it("builds the snapshot with each PR's split, checkout and task, and publishes only when it changed", async () => {
    const { pulls, published } = setup({ hits: [hit(1), hit(2), hit(3, "o/b")], nodes: { 1: node(1), 2: node(2, { reviewDecision: null }), 3: node(3, { headRepository: { nameWithOwner: "o/b" } }) } });
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

describe("GitHubPulls.merge", () => {
  it("refuses a PR outside Ready to merge, squashes a ready one, and polls again", async () => {
    const world: World = { hits: [hit(1), hit(2)], nodes: { 1: node(1), 2: node(2, { reviewDecision: null }) } };
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

describe("GitHubPulls.clone", () => {
  const root = mkdtempSync(join(tmpdir(), "pulls-clone-"));

  it("refuses a relative destination, a missing parent and an existing target", async () => {
    const { pulls } = setup({ hits: [], nodes: {} });
    await expect(pulls.clone("o/b", "relative/b")).rejects.toThrow(CloneError);
    await expect(pulls.clone("o/b", join(root, "nope", "b"))).rejects.toThrow(CloneError);
    mkdirSync(join(root, "taken"));
    await expect(pulls.clone("o/b", join(root, "taken"))).rejects.toThrow(CloneError);
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
    expect(calls).toContainEqual(["git", "-c", "core.hooksPath=/dev/null", "clone", "https://github.com/o/b.git", dest]);
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
