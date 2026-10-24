// The delivering stage: push the task's branch and open a draft PR on the host, so CI starts
// early. Like shipping it needs only git and gh, not a Claude credential.
import { type GitDeps, findPr, openPr, pushBranch } from "../../adapters/github/gh.ts";
import { exec as realExec } from "../../adapters/process/exec.ts";
import type { StageRunner } from "../ports.ts";

export function deliverRunner(deps: GitDeps): StageRunner {
  return async (context) => {
    const { task } = context;
    if (!task.repoPath || !task.branch || !task.worktreePath) {
      return { outcome: "fail", detail: { error: "no branch to deliver; the implementer never ran for real" } };
    }
    const pushError = await pushBranch(deps, task.branch, task.worktreePath);
    if (pushError) return { outcome: "fail", detail: { error: pushError } };

    const existing = await findPr(deps, task.branch, task.worktreePath);
    const opened = existing ? { ref: existing } : await openPr(deps, context, { draft: true });
    if ("error" in opened) return { outcome: "fail", detail: { error: opened.error } };
    const { url, number } = opened.ref;
    return {
      outcome: "pass",
      detail: { prUrl: url, prNumber: number, draft: opened.ref.isDraft, reused: existing !== null },
      events: [{ at: new Date().toISOString(), kind: "pr.opened", payload: { url, number } }],
    };
  };
}

export const realDeliverRunner: StageRunner = deliverRunner({ exec: realExec });
