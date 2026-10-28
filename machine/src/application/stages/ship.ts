// The ship stage: the PR was opened as a draft at delivering, so shipping pushes any last
// commits and marks it ready for review. Git on the host for the push, the GitHub port for the PR.
import { originSlugOf } from "../../adapters/git/worktree.ts";
import { exec as realExec } from "../../adapters/process/exec.ts";
import { type GitHub, messageOf } from "../github.ts";
import type { StageRunner } from "../ports.ts";
import { type DeliverDeps, openTaskPr, pushBranch } from "./deliver.ts";

export function shipRunnerWith(deps: DeliverDeps): StageRunner {
  const slugOf = deps.slugOf ?? originSlugOf;
  return async (context) => {
    const { task } = context;
    if (!task.repoPath || !task.branch || !task.worktreePath) {
      return { outcome: "fail", detail: { error: "no branch to ship; the implementer never ran for real" } };
    }
    const cwd = task.worktreePath;
    const pushError = await pushBranch(deps.exec, task.branch, cwd);
    if (pushError) return { outcome: "fail", detail: { error: pushError } };
    const slug = await slugOf(cwd);
    if (!slug) return { outcome: "fail", detail: { error: "the worktree's origin is not a GitHub repository" } };
    try {
      const existing = await deps.github.findPr(slug, task.branch);
      if (!existing) {
        // Delivering was skipped (an older task): open the PR ready, as shipping used to.
        const opened = await openTaskPr(deps.github, slug, context, false);
        return { outcome: "pass", detail: { prUrl: opened.url, readied: false } };
      }
      if (!existing.isDraft) return { outcome: "pass", detail: { prUrl: existing.url, readied: false } };
      await deps.github.markPrReady(slug, existing.number);
      return { outcome: "pass", detail: { prUrl: existing.url, readied: true } };
    } catch (error) {
      return { outcome: "fail", detail: { error: messageOf(error) } };
    }
  };
}

export const shipRunner = (github: GitHub): StageRunner => shipRunnerWith({ exec: realExec, github });
