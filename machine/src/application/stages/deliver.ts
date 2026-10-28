// The delivering stage: push the task's branch and open a draft PR on the host, so CI starts
// early. The push is git with your own credentials; the PR is the GitHub port.
import { HOST_GIT, originSlugOf } from "../../adapters/git/worktree.ts";
import { type ExecResult, exec as realExec } from "../../adapters/process/exec.ts";
import { buildPr } from "../../domain/prbody.ts";
import { approvedPlan } from "../../domain/stage-input.ts";
import { type GitHub, messageOf } from "../github.ts";
import type { StageContext, StageRunner } from "../ports.ts";

export type ExecFn = (command: string, args: string[], options?: { cwd?: string; signal?: AbortSignal; timeoutMs?: number }) => Promise<ExecResult>;

export interface DeliverDeps {
  exec: ExecFn;
  github: GitHub;
  /** The `owner/name` a worktree pushes to; tests inject one, the default reads the origin remote. */
  slugOf?: (cwd: string) => Promise<string | null>;
}

/** A command's output, or a hint when it produced none. */
export function describe(result: ExecResult): string {
  const text = (result.stderr || result.stdout).trim();
  return text || `exit code ${result.code}`;
}

/** Pushes the task's branch from its worktree. Returns an error message on failure. */
export async function pushBranch(exec: ExecFn, branch: string, cwd: string): Promise<string | null> {
  const pushed = await exec("git", [...HOST_GIT, "-C", cwd, "push", "-u", "origin", branch]);
  return pushed.code === 0 ? null : `git push failed: ${describe(pushed)}`;
}

/** Opens the PR for a task's branch with the caveman body. */
export async function openTaskPr(github: GitHub, slug: string, context: StageContext, draft: boolean) {
  const { task } = context;
  const { title, body } = buildPr({ task, plan: approvedPlan(context.approvals), repoSlug: slug });
  return github.openPr(slug, { title, body, head: task.branch!, draft });
}

export function deliverRunner(deps: DeliverDeps): StageRunner {
  const slugOf = deps.slugOf ?? originSlugOf;
  return async (context) => {
    const { task } = context;
    if (!task.repoPath || !task.branch || !task.worktreePath) {
      return { outcome: "fail", detail: { error: "no branch to deliver; the implementer never ran for real" } };
    }
    const pushError = await pushBranch(deps.exec, task.branch, task.worktreePath);
    if (pushError) return { outcome: "fail", detail: { error: pushError } };
    const slug = await slugOf(task.worktreePath);
    if (!slug) return { outcome: "fail", detail: { error: "the worktree's origin is not a GitHub repository" } };
    try {
      const existing = await deps.github.findPr(slug, task.branch);
      const ref = existing ?? (await openTaskPr(deps.github, slug, context, true));
      return {
        outcome: "pass",
        detail: { prUrl: ref.url, prNumber: ref.number, draft: ref.isDraft, reused: existing !== null },
        events: [{ at: new Date().toISOString(), kind: "pr.opened", payload: { url: ref.url, number: ref.number } }],
      };
    } catch (error) {
      return { outcome: "fail", detail: { error: messageOf(error) } };
    }
  };
}

/** The real runner needs the GitHub port, which main.ts builds from the token. */
export const realDeliverRunner = (github: GitHub): StageRunner => deliverRunner({ exec: realExec, github });
