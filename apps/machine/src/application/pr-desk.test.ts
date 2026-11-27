import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { PrNode } from "../domain/pull-request.ts";
import { fakeGitHub } from "../test/github.ts";
import { OutsideReposError, PrDesk, PushFailedError } from "./pr-desk.ts";
import { NoPullError } from "./pulls.ts";

const node = (number: number): PrNode => ({
  number,
  title: `PR ${number}`,
  url: `https://github.com/o/a/pull/${number}`,
  isDraft: false,
  updatedAt: "2026-11-27T10:00:00Z",
  baseRefName: "main",
  headRefName: `feat/${number}`,
  author: { login: "me" },
  headRepository: { nameWithOwner: "o/a" },
  reviewDecision: null,
  mergeable: "MERGEABLE",
  reviewRequests: { nodes: [] },
  reviewThreads: { nodes: [] },
  commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
});

function repos() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "desk-")));
  const inside = join(root, "Developer", "a");
  mkdirSync(inside, { recursive: true });
  const outside = join(root, "elsewhere");
  mkdirSync(outside);
  return { reposDir: join(root, "Developer"), inside, outside, root };
}

describe("PrDesk.detail: one PR read now, for a client's PR tab", () => {
  it("reads its facts, state, threads with the resolved ones, reviews and files", async () => {
    const github = fakeGitHub({
      viewer: async () => ({ login: "me", teams: [] }),
      prFacts: async () => node(7),
      prMerged: async () => ({ merged: false, mergedSha: null, state: "open", mergedAt: null }),
      prThreads: async () => [{ id: "T1", path: "a.ts", line: 3, resolved: false, outdated: false, comments: [{ id: 1, author: "r", body: "why?", at: "2026-11-27T09:00:00Z", association: "MEMBER" }] }],
      prReviews: async () => [{ author: "r", state: "CHANGES_REQUESTED", commitId: "abc", at: "2026-11-27T09:00:00Z", association: "MEMBER" }],
      prFiles: async () => [{ path: "a.ts", additions: 3, deletions: 1 }],
    });
    const desk = new PrDesk({ github, reposDir: "/r" });
    const got = await desk.detail("o/a", 7);
    expect(got).toMatchObject({
      repo: "o/a",
      number: 7,
      state: "open",
      facts: { number: 7, title: "PR 7", mine: true },
      threads: [{ id: "T1", path: "a.ts", line: 3, resolved: false, outdated: false, comments: [{ author: "r", body: "why?", at: "2026-11-27T09:00:00Z" }] }],
      reviews: [{ author: "r", state: "CHANGES_REQUESTED", at: "2026-11-27T09:00:00Z" }],
      files: [{ path: "a.ts", additions: 3, deletions: 1 }],
    });
    expect(github.calls.find((c) => c[0] === "prThreads")).toEqual(["prThreads", "o/a", 7, { includeResolved: true }]);
  });

  it("says merged for a merged PR, and 404s one GitHub no longer shows", async () => {
    const merged = fakeGitHub({
      viewer: async () => ({ login: "me", teams: [] }),
      prFacts: async () => node(7),
      prMerged: async () => ({ merged: true, mergedSha: "abc", state: "closed", mergedAt: "2026-11-27T09:00:00Z" }),
      prThreads: async () => [],
      prReviews: async () => [],
      prFiles: async () => [],
    });
    expect((await new PrDesk({ github: merged, reposDir: "/r" }).detail("o/a", 7)).state).toBe("merged");
    const gone = fakeGitHub({ viewer: async () => ({ login: "me", teams: [] }), prFacts: async () => null });
    await expect(new PrDesk({ github: gone, reposDir: "/r" }).detail("o/a", 9)).rejects.toBeInstanceOf(NoPullError);
  });
});

describe("PrDesk: ready, lookup, search", () => {
  it("marks a draft ready and polls the inbox again", async () => {
    const polled: string[] = [];
    const github = fakeGitHub({ markPrReady: async () => undefined });
    await new PrDesk({ github, reposDir: "/r", repoll: async () => void polled.push("poll") }).ready("o/a", 7);
    expect(github.calls).toEqual([["markPrReady", "o/a", 7]]);
    expect(polled).toEqual(["poll"]);
  });

  it("finds a branch's open PR, or none", async () => {
    const github = fakeGitHub({ findPr: async (_slug, branch) => (branch === "feat/x" ? { url: "https://github.com/o/a/pull/3", number: 3, isDraft: true } : null) });
    const desk = new PrDesk({ github, reposDir: "/r" });
    expect(await desk.lookup("o/a", "feat/x")).toEqual({ url: "https://github.com/o/a/pull/3", number: 3, isDraft: true });
    expect(await desk.lookup("o/a", "feat/y")).toBeNull();
  });

  it("searches a repository's PRs or issues", async () => {
    const github = fakeGitHub({ searchIssues: async () => [{ number: 4, title: "Crash on open", url: "https://github.com/o/a/issues/4", state: "open", author: "r" }] });
    expect(await new PrDesk({ github, reposDir: "/r" }).search("o/a", "issue", "crash")).toEqual([{ number: 4, title: "Crash on open", url: "https://github.com/o/a/issues/4", state: "open", author: "r" }]);
    expect(github.calls).toEqual([["searchIssues", "o/a", "issue", "crash"]]);
  });
});

describe("PrDesk.openPr: push a local branch and open its PR", () => {
  it("pushes, opens the PR on the checkout's own repository, and hands back a PR that is already open", async () => {
    const { reposDir, inside } = repos();
    const pushed: string[] = [];
    const github = fakeGitHub({
      findPr: async () => null,
      openPr: async (_slug, pr) => ({ url: "https://github.com/o/a/pull/5", number: 5, isDraft: pr.draft }),
    });
    const desk = new PrDesk({ github, reposDir, originOf: async () => "o/a", push: async (branch, cwd) => {
      pushed.push(`${branch}@${cwd}`);
      return null;
    } });
    const got = await desk.openPr({ path: inside, branch: "feat/x", title: "Feat", body: "Body", draft: false });
    expect(got).toEqual({ url: "https://github.com/o/a/pull/5", number: 5, isDraft: false });
    expect(pushed).toEqual([`feat/x@${inside}`]);
    expect(github.calls.find((c) => c[0] === "openPr")).toEqual(["openPr", "o/a", { title: "Feat", body: "Body", head: "feat/x", draft: false }]);
    const existing = fakeGitHub({ findPr: async () => ({ url: "https://github.com/o/a/pull/2", number: 2, isDraft: false }) });
    const again = new PrDesk({ github: existing, reposDir, originOf: async () => "o/a", push: async () => null });
    expect(await again.openPr({ path: inside, branch: "feat/x", title: "Feat", body: "Body", draft: false })).toMatchObject({ number: 2 });
  });

  it("refuses a folder outside the repositories the machine sees, a symlink out included, and says why a push failed", async () => {
    const { reposDir, inside, outside, root } = repos();
    const github = fakeGitHub({ findPr: async () => null });
    const desk = new PrDesk({ github, reposDir, originOf: async () => "o/a", push: async () => "git push failed: rejected" });
    await expect(desk.openPr({ path: outside, branch: "b", title: "t", body: "", draft: false })).rejects.toBeInstanceOf(OutsideReposError);
    const link = join(reposDir, "sneaky");
    symlinkSync(join(root, "elsewhere"), link);
    await expect(desk.openPr({ path: link, branch: "b", title: "t", body: "", draft: false })).rejects.toBeInstanceOf(OutsideReposError);
    await expect(desk.openPr({ path: inside, branch: "b", title: "t", body: "", draft: false })).rejects.toThrow(PushFailedError);
  });

  it("refuses a folder with no GitHub origin", async () => {
    const { reposDir, inside } = repos();
    const desk = new PrDesk({ github: fakeGitHub(), reposDir, originOf: async () => null, push: async () => null });
    await expect(desk.openPr({ path: inside, branch: "b", title: "t", body: "", draft: false })).rejects.toThrow(/no GitHub origin/);
  });
});
