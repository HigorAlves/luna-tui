// A PR task: an action from the PR inbox turned into a task that walks one of the short
// routes. The worktree is prepared on the PR's own head branch before the task exists, so
// every stage finds `task.branch` and `task.worktreePath` set and never invents a task branch.
import type { PrAction, PullRequest, TaskSource } from "@hardness/contracts";

import { ensurePrWorktree as realEnsurePrWorktree, prWorktreePath } from "../adapters/git/worktree.ts";
import { canPush } from "../domain/pull-request.ts";
import type { TaskRow } from "../domain/task.ts";
import type { NewTask } from "./pipeline.ts";

export class NoCheckoutError extends Error {
  constructor(repo: string) {
    super(`no local checkout of ${repo}; clone it first`);
    this.name = "NoCheckoutError";
  }
}

export class ForkError extends Error {
  constructor(repo: string, number: number) {
    super(`${repo}#${number} comes from a fork; the machine cannot push to it`);
    this.name = "ForkError";
  }
}

export class OwnPrError extends Error {
  constructor(repo: string, number: number) {
    super(`${repo}#${number} is yours; review is for other people's PRs`);
    this.name = "OwnPrError";
  }
}

export class PrBusyError extends Error {
  constructor(repo: string, number: number, taskId: string) {
    super(`${repo}#${number} already has a task running (${taskId.slice(0, 8)})`);
    this.name = "PrBusyError";
  }
}

export interface PrTaskDeps {
  worktreesDir: string;
  pipeline: {
    findBySource(repo: string, number: number, kind: "github_pr"): Promise<TaskRow | null>;
    createTask(input: NewTask): Promise<TaskRow>;
    start(id: string): Promise<TaskRow>;
  };
  /** Tests inject a fake; the default runs git. */
  ensurePrWorktree?: (repoPath: string, headRef: string, path: string) => Promise<void>;
}

/** What each route is for, as the task's one criterion. */
function briefFor(pr: PullRequest, action: PrAction): { description: string; criteria: string[] } {
  const ref = `PR #${pr.number}`;
  switch (action) {
    case "ci_fix":
      return {
        description: `Make CI green on ${pr.url} (${pr.headRef} into ${pr.baseRef}). Failed checks: ${pr.checks.failed.map((c) => c.name).join(", ") || "none listed"}.`,
        criteria: [`Every check on ${ref} is green`],
      };
    case "review":
      return {
        description: `Review ${pr.url} by @${pr.author} (${pr.headRef} into ${pr.baseRef}).`,
        criteria: [`${ref} has a review with line-anchored findings`],
      };
    case "address":
      return {
        description: `Address the ${pr.unresolvedThreads} unresolved review thread(s) on ${pr.url} (${pr.headRef} into ${pr.baseRef}).`,
        criteria: [`Every unresolved review thread on ${ref} is answered`],
      };
  }
}

/** Creates and starts the task for `action` on `pr`. Throws one of the errors above when it cannot. */
export async function createPrTask(deps: PrTaskDeps, pr: PullRequest, action: PrAction): Promise<TaskRow> {
  if (pr.localPath === null) throw new NoCheckoutError(pr.repo);
  if (action !== "review" && !canPush(pr)) throw new ForkError(pr.repo, pr.number);
  if (action === "review" && pr.mine) throw new OwnPrError(pr.repo, pr.number);
  const running = await deps.pipeline.findBySource(pr.repo, pr.number, "github_pr");
  if (running && running.state !== "closed") throw new PrBusyError(pr.repo, pr.number, running.id);

  const worktreePath = prWorktreePath(pr.localPath, deps.worktreesDir, pr.number, pr.headRef);
  await (deps.ensurePrWorktree ?? realEnsurePrWorktree)(pr.localPath, pr.headRef, worktreePath);

  const source: TaskSource = { kind: "github_pr", repo: pr.repo, number: pr.number, url: pr.url, headRef: pr.headRef, baseRef: pr.baseRef };
  const task = await deps.pipeline.createTask({
    title: `PR #${pr.number}: ${pr.title}`,
    ...briefFor(pr, action),
    repoPath: pr.localPath,
    source,
    route: action,
    branch: pr.headRef,
    worktreePath,
  });
  return deps.pipeline.start(task.id);
}
