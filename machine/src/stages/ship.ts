// The ship stage: the PR was opened as a draft at delivering, so shipping pushes any last
// commits and marks it ready for review. It runs on the host with your own git and gh
// credentials, never in a sandboxed container.
import { type GitDeps, describe, findPr, markPrReady, openPr, pushBranch } from "../github/gh.ts";
import { exec as realExec } from "../sandbox/exec.ts";
import type { StageRunner } from "./runner.ts";

export function shipRunnerWith(deps: GitDeps): StageRunner {
  return async (context) => {
    const { task } = context;
    if (!task.repoPath || !task.branch || !task.worktreePath) {
      return { outcome: "fail", detail: { error: "no branch to ship; the implementer never ran for real" } };
    }
    const cwd = task.worktreePath;
    const pushError = await pushBranch(deps, task.branch, cwd);
    if (pushError) return { outcome: "fail", detail: { error: pushError } };

    const existing = await findPr(deps, task.branch, cwd);
    if (!existing) {
      // Delivering was skipped (an older task): open the PR ready, as shipping used to.
      const opened = await openPr(deps, context, { draft: false });
      if ("error" in opened) return { outcome: "fail", detail: { error: opened.error } };
      return { outcome: "pass", detail: { prUrl: opened.ref.url, readied: false } };
    }
    if (!existing.isDraft) return { outcome: "pass", detail: { prUrl: existing.url, readied: false } };

    const ready = await markPrReady(deps, existing.number, cwd);
    if (ready.code !== 0) return { outcome: "fail", detail: { error: `gh pr ready failed: ${describe(ready)}` } };
    return { outcome: "pass", detail: { prUrl: existing.url, readied: true } };
  };
}

export const shipRunner: StageRunner = shipRunnerWith({ exec: realExec });
