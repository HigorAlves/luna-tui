// The delivering stage: push the task's branch and open a draft PR on the host, so CI starts
// early. The push is git with your own credentials; the PR is the GitHub port.
import { at } from "../../adapters/git/machine-repo.ts";
import { HOST_GIT, type RebaseResult, branchBase, defaultBranch as hostDefaultBranch, originSlugOf, rebaseOntoDefault } from "../../adapters/git/worktree.ts";
import { type ExecResult, exec as realExec } from "../../adapters/process/exec.ts";
import { type PrExtra, buildPr, mergePrSection } from "../../domain/prbody.ts";
import { approvedPlan, approvedScenarios } from "../../domain/stage-input.ts";
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
  /** The commit the branch forked from and the one it is at, for the body; absent or null leaves them out. */
  commitsOf?: (worktreePath: string, repoPath: string) => Promise<{ base: string | null; head: string | null } | null>;
}

/** A command's output, or a hint when it produced none. */
export function describe(result: ExecResult): string {
  const text = (result.stderr || result.stdout).trim();
  return text || `exit code ${result.code}`;
}

/** What the machine itself pushed, kept in the card's own repository as `refs/luna/pushed/<name>`: a commit reachable from one is not lost if the workspace goes. */
async function recordPushed(exec: ExecFn, cwd: string, name: string, commit: string): Promise<void> {
  await exec("git", [...HOST_GIT, ...at(cwd), "update-ref", `refs/luna/pushed/${name}`, commit]).catch(() => {});
}

/** Pushes the task's branch from its worktree. Returns an error message on failure. */
export async function pushBranch(exec: ExecFn, branch: string, cwd: string, options: { force?: boolean; lease?: string } = {}): Promise<string | null> {
  // `--force-with-lease`: after a rebase, only over the head this worktree last saw on the task's own branch.
  // With `lease` (a sha the machine read) the lease is pinned to it, so a concurrent fetch cannot move what it is compared with.
  if (options.lease !== undefined && !/^[0-9a-f]{40,64}$/.test(options.lease)) return "git push refused: the lease is not a commit sha";
  const force = options.force ? [options.lease ? `--force-with-lease=refs/heads/${branch}:${options.lease}` : "--force-with-lease"] : [];
  const pushed = await exec("git", [...HOST_GIT, ...at(cwd), "push", ...force, "-u", "origin", branch]);
  if (pushed.code !== 0) return `git push failed: ${describe(pushed)}`;
  await recordPushed(exec, cwd, branch, `refs/heads/${branch}`);
  return null;
}

/** The ref a Build checkpoint goes to: outside refs/heads and refs/tags, so no CI runs on it and no PR head moves. */
export const checkpointRef = (branch: string): string => `refs/luna/wip/${branch}`;

/** Pushes the worktree's HEAD to the branch's checkpoint ref (forced: the ref is the machine's own). Returns an error message on failure. */
export async function pushCheckpoint(exec: ExecFn, branch: string, cwd: string, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<string | null> {
  const pushed = await exec("git", [...HOST_GIT, ...at(cwd), "push", "--force", "origin", `HEAD:${checkpointRef(branch)}`], options);
  if (pushed.code !== 0) return `git push failed: ${describe(pushed)}`;
  await recordPushed(exec, cwd, `wip/${branch}`, "HEAD");
  return null;
}

/** What the record, the plan and the scenarios say, for the machine's section of the body. */
export function prExtraOf(context: StageContext, commits: { base: string | null; head: string | null } | null): PrExtra {
  const { task } = context;
  return {
    record: task.record,
    // The plan's version: how many times a plan was approved (a plan sent back and approved again counts).
    planVersion: context.approvals.filter((a) => a.kind === "awaiting_approval" && a.decision === "approved").length || null,
    scenarios: approvedScenarios(context.approvals).map((sc) => ({ id: sc.id ?? "", title: sc.title, criterion: sc.criterion_ref ?? null, test: context.prFacts?.tests.get(sc.id ?? "") ?? null })),
    findings: context.prFacts?.findings ?? [],
    outOfMap: context.prFacts?.outOfMap ?? [],
    ...(commits ?? {}),
  };
}

/** Opens the PR for a task's branch with the caveman body. */
export async function openTaskPr(github: GitHub, slug: string, context: StageContext, draft: boolean, extra?: PrExtra) {
  const { task } = context;
  const { title, body } = buildPr({ task, plan: approvedPlan(context.approvals), repoSlug: slug, ...(extra ? { extra } : {}) });
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
      const commits = deps.commitsOf ? await deps.commitsOf(task.worktreePath, task.repoPath).catch(() => null) : null;
      const extra = prExtraOf(context, commits);
      const ref = existing ?? (await openTaskPr(deps.github, slug, context, true, extra));
      // A PR that exists keeps whatever a person wrote: only the machine's own section is replaced.
      if (existing) {
        const current = await deps.github.prFacts(slug, ref.number).catch(() => null);
        const fresh = buildPr({ task, plan: approvedPlan(context.approvals), repoSlug: slug, extra }).body;
        if (current) await deps.github.updatePrBody(slug, ref.number, mergePrSection(current.body ?? "", fresh)).catch(() => {});
      }
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
export const realDeliverRunner = (github: GitHub): StageRunner => deliverRunner({
    exec: realExec,
    github,
    commitsOf: async (worktreePath, repoPath) => {
      const head = await realExec("git", [...HOST_GIT, ...at(worktreePath), "rev-parse", "HEAD"]).catch(() => null);
      return { base: await branchBase(worktreePath, repoPath).catch(() => null), head: head && head.code === 0 ? head.stdout.trim() : null };
    },
  });
