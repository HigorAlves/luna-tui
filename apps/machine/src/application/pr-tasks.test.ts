import type { PullRequest } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import type { TaskRow } from "../domain/task.ts";
import type { NewTask } from "./pipeline.ts";
import { ForkError, NoCheckoutError, OwnPrError, PrBusyError, createPrTask } from "./pr-tasks.ts";

const pr = (over: Partial<PullRequest> = {}): PullRequest => ({
  repo: "o/a",
  number: 12,
  title: "Export CSV",
  url: "https://github.com/o/a/pull/12",
  author: "them",
  mine: false,
  reviewRequested: true,
  isDraft: false,
  headRef: "feat/export",
  baseRef: "main",
  fromFork: false,
  reviewDecision: null,
  mergeable: "MERGEABLE",
  mergeState: "CLEAN",
  checks: { state: "failure", passed: 1, total: 2, failed: [{ name: "lint", state: "FAILURE", url: null }], all: [{ name: "build", state: "SUCCESS", url: null }, { name: "lint", state: "FAILURE", url: null }] },
  unresolvedThreads: 0,
  split: "review_requested",
  localPath: "/r/a",
  task: null,
  updatedAt: "2026-10-27T10:00:00Z",
  headSha: null,
  headCommittedAt: null,
  nodeId: null,
  body: null,
  ...over,
});

function setup(existing: Partial<TaskRow> | Array<Partial<TaskRow>> | null = null) {
  const rewatched: string[] = [];
  const open = (Array.isArray(existing) ? existing : existing ? [existing] : []).map((e) => ({ id: "old", state: "closed", route: "ci_fix", ...e }) as TaskRow).filter((t) => t.state !== "closed" && t.state !== "archived");
  const created: Record<string, unknown>[] = [];
  const started: string[] = [];
  const worktrees: string[][] = [];
  const deps = {
    worktreesDir: "/wt",
    ensurePrClone: async (repoPath: string, headRef: string, path: string) => void worktrees.push([repoPath, headRef, path]),
    pipeline: {
      findOpenBySource: async () => open,
      rewatch: async (id: string) => {
        rewatched.push(id);
        return { id } as TaskRow;
      },
      createTask: async (input: NewTask) => {
        created.push(input as unknown as Record<string, unknown>);
        return { id: "new", ...input } as unknown as TaskRow;
      },
      start: async (id: string) => {
        started.push(id);
        return { id } as TaskRow;
      },
    },
  };
  return { deps, created, started, worktrees, rewatched };
}

describe("createPrTask", () => {
  it("prepares a worktree on the PR's head and starts a task that carries the PR, the route and the branch", async () => {
    const { deps, created, started, worktrees } = setup();
    const task = await createPrTask(deps, pr(), "ci_fix");
    expect(task.id).toBe("new");
    expect(worktrees).toEqual([["/r/a", "feat/export", "/wt/a/pr-12-feat-export"]]);
    expect(created[0]).toMatchObject({
      title: "PR #12: Export CSV",
      repoPath: "/r/a",
      route: "ci_fix",
      branch: "feat/export",
      worktreePath: "/wt/a/pr-12-feat-export",
      source: { kind: "github_pr", repo: "o/a", number: 12, url: "https://github.com/o/a/pull/12", headRef: "feat/export", baseRef: "main" },
    });
    expect(created[0]!.criteria).toEqual(["Every check on PR #12 is green"]);
    expect(started).toEqual(["new"]);
  });

  it("keeps the author's association on the source, so the card's trust is known", async () => {
    const { deps, created } = setup();
    await createPrTask(deps, pr({ authorAssociation: "FIRST_TIME_CONTRIBUTOR" }), "review");
    await createPrTask(deps, pr(), "review");
    expect(created[0]!.source).toMatchObject({ kind: "github_pr", authorAssociation: "FIRST_TIME_CONTRIBUTOR" });
    expect(created[1]!.source).not.toHaveProperty("authorAssociation");
  });

  it("gives each route its own brief", async () => {
    const { deps, created } = setup();
    await createPrTask(deps, pr(), "review");
    await createPrTask(deps, pr({ mine: true, author: "me", unresolvedThreads: 2 }), "address");
    expect(created[0]!.criteria).toEqual(["PR #12 has a review with line-anchored findings"]);
    expect(created[1]!.criteria).toEqual(["Every unresolved review thread on PR #12 is answered"]);
  });

  it("refuses a PR without a checkout, a fix or an address on a fork, a review of your own PR, and a second task while one runs", async () => {
    await expect(createPrTask(setup().deps, pr({ localPath: null }), "ci_fix")).rejects.toThrow(NoCheckoutError);
    await expect(createPrTask(setup().deps, pr({ fromFork: true }), "ci_fix")).rejects.toThrow(ForkError);
    await expect(createPrTask(setup().deps, pr({ fromFork: true, mine: true }), "address")).rejects.toThrow(ForkError);
    await expect(createPrTask(setup().deps, pr({ mine: true, author: "me" }), "review")).rejects.toThrow(OwnPrError);
    await expect(createPrTask(setup({ state: "ci_watch" }).deps, pr(), "ci_fix")).rejects.toThrow(PrBusyError);
    const { deps, started } = setup({ state: "closed" });
    await createPrTask(deps, pr(), "ci_fix");
    expect(started).toEqual(["new"]);
  });

  it("a card of the same route watching the PR is looped back at once, no new task, no new worktree", async () => {
    const { deps, created, started, worktrees, rewatched } = setup({ id: "watching", state: "pr_watch", route: "ci_fix" });
    const task = await createPrTask(deps, pr(), "ci_fix");
    expect(task.id).toBe("watching");
    expect(rewatched).toEqual(["watching"]);
    expect(created).toEqual([]);
    expect(started).toEqual([]);
    expect(worktrees).toEqual([]);
  });

  it("a card of another route watching the PR does not block a new task, and a running one still does", async () => {
    const { deps, created, rewatched } = setup({ state: "pr_watch", route: "review" });
    await createPrTask(deps, pr(), "ci_fix");
    expect(created).toHaveLength(1);
    expect(rewatched).toEqual([]);
    await expect(createPrTask(setup([{ state: "pr_watch", route: "review" }, { id: "run", state: "ci_watch", route: "ci_fix" }]).deps, pr(), "address")).rejects.toThrow(PrBusyError);
  });

  it("reviews a fork PR read-only", async () => {
    const { deps, worktrees } = setup();
    await createPrTask(deps, pr({ fromFork: true }), "review");
    expect(worktrees).toHaveLength(1);
  });
});
