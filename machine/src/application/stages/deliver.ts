// The delivering stage: push the task's branch and open a draft PR on the host, so CI starts
// early. The push is git with your own credentials; the PR is the GitHub port.
import { HOST_GIT, type RebaseResult, defaultBranch as hostDefaultBranch, originSlugOf, rebaseOntoDefault } from "../../adapters/git/worktree.ts";
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
  /** The repo's default branch, for the rebase; tests inject one. */
  defaultBranch?: (repoPath: string) => Promise<string | null>;
}

/** A command's output, or a hint when it produced none. */
export function describe(result: ExecResult): string {
  const text = (result.stderr || result.stdout).trim();
  return text || `exit code ${result.code}`;
}

/** Pushes the task's branch from its worktree. Returns an error message on failure. */
export async function pushBranch(exec: ExecFn, branch: string, cwd: string, options: { force?: boolean } = {}): Promise<string | null> {
  // `--force-with-lease`: after a rebase, only over the head this worktree last saw on the task's own branch.
  const pushed = await exec("git", [...HOST_GIT, "-C", cwd, "push", ...(options.force ? ["--force-with-lease"] : []), "-u", "origin", branch]);
  return pushed.code === 0 ? null : `git push failed: ${describe(pushed)}`;
}

/** The ref a Build checkpoint goes to: outside refs/heads and refs/tags, so no CI runs on it and no PR head moves. */
export const checkpointRef = (branch: string): string => `refs/luna/wip/${branch}`;

/** Pushes the worktree's HEAD to the branch's checkpoint ref (forced: the ref is the machine's own). Returns an error message on failure. */
export async function pushCheckpoint(exec: ExecFn, branch: string, cwd: string, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<string | null> {
  const pushed = await exec("git", [...HOST_GIT, "-C", cwd, "push", "--force", "origin", `HEAD:${checkpointRef(branch)}`], options);
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
      // GitHub knows whether the branch still merges: once a conflict is reported, rebase it once and push it back.
      const facts = await deps.github.prFacts(slug, ref.number).catch(() => null);
      let rebase: Record<string, unknown> = facts?.mergeable === "UNKNOWN" ? { mergeable: "UNKNOWN" } : {};
      if (facts?.mergeable === "CONFLICTING") {
        const base = deps.defaultBranch ?? hostDefaultBranch;
        const rebased: RebaseResult = await rebaseOntoDefault(deps.exec, task.worktreePath, task.repoPath, base);
        if (!rebased.ok) {
          const files = rebased.conflicts.join(", ");
          return {
            outcome: "fail",
            detail: {
              error: rebased.conflicts.length > 0 ? `the branch conflicts with ${(await base(task.repoPath)) ?? "the default branch"} and the rebase stopped on: ${files}` : `the branch conflicts with the default branch and could not be rebased: ${rebased.error}`,
              conflicts: rebased.conflicts,
              escalation: "other",
            },
          };
        }
        const forced = await pushBranch(deps.exec, task.branch, task.worktreePath, { force: true });
        if (forced) return { outcome: "fail", detail: { error: forced } };
        rebase = { rebased: true, onto: rebased.onto };
      }
      return {
        outcome: "pass",
        detail: { prUrl: ref.url, prNumber: ref.number, draft: ref.isDraft, reused: existing !== null, ...rebase },
        events: [{ at: new Date().toISOString(), kind: "pr.opened", payload: { url: ref.url, number: ref.number } }],
      };
    } catch (error) {
      return { outcome: "fail", detail: { error: messageOf(error) } };
    }
  };
}

/** The real runner needs the GitHub port, which main.ts builds from the token. */
export const realDeliverRunner = (github: GitHub): StageRunner => deliverRunner({ exec: realExec, github });
