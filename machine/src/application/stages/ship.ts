// The ship stage: the PR was opened as a draft at delivering, so shipping pushes any last
// commits, publishes the task's Evidence Pack onto it when there is one, and marks it ready for
// review. Git on the host for the push, the GitHub port for the PR. The pack is published here,
// at the approval of the preview gate, and only once it is complete and its commit is the PR head:
// a head that moved sends the task back to Evidence.
import type { EvidencePack } from "@hardness/contracts";

import { headCommit as worktreeHead, originSlugOf } from "../../adapters/git/worktree.ts";
import { exec as realExec } from "../../adapters/process/exec.ts";
import { packComplete } from "../../domain/evidence-pack.ts";
import type { PublishEvidence } from "../evidence-publish.ts";
import { type GitHub, messageOf } from "../github.ts";
import type { StageResult, StageRunner } from "../ports.ts";
import { type DeliverDeps, openTaskPr, pushBranch } from "./deliver.ts";

export interface ShipDeps extends DeliverDeps {
  /** The Evidence Pack of the task: where it is read from and saved to, how it is published, where its local copy lives. Absent means ship without one. */
  evidence?: {
    load: (taskId: string) => Promise<EvidencePack | null>;
    save: (taskId: string, pack: EvidencePack) => Promise<void>;
    publish: PublishEvidence;
    store: { dirFor: (taskId: string, sha: string) => string };
  };
  /** The worktree's HEAD, for a PR GitHub names no head for; tests inject one. */
  headCommit?: (worktreePath: string) => Promise<string>;
}

export function shipRunnerWith(deps: ShipDeps): StageRunner {
  const slugOf = deps.slugOf ?? originSlugOf;
  const headOf = deps.headCommit ?? worktreeHead;
  /** The pack's turn at the gate: nothing to do (no pack), a stop (the head moved, the pack is incomplete), or what was published. */
  const evidencePhase = async (slug: string, number: number, taskId: string, worktreePath: string): Promise<{ stop: StageResult } | { published: Record<string, unknown> } | { none: true }> => {
    const evidence = deps.evidence;
    if (!evidence) return { none: true };
    const pack = await evidence.load(taskId);
    if (!pack) return { none: true };
    const head = (await deps.github.prHeadSha(slug, number)) ?? (await headOf(worktreePath)).trim();
    if (pack.commitSha !== head) {
      return {
        stop: {
          outcome: "escalated",
          detail: { escalation: "head_moved", reason: `the PR head moved after the evidence pack (${pack.commitSha.slice(0, 7)} → ${head.slice(0, 7)}): Evidence runs again`, options: [] },
        },
      };
    }
    const complete = packComplete(pack, head);
    if (!complete.ok) return { stop: { outcome: "fail", detail: { error: `the evidence pack is not complete: ${complete.problems.join("; ")}` } } };
    const done = await evidence.publish({ github: deps.github, slug, number, taskId, pack, localDir: evidence.store.dirFor(taskId, pack.commitSha) });
    await evidence.save(taskId, done.pack);
    return { published: { comment: done.comment, assets: done.assets } };
  };
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
      // Delivering was skipped (an older task): open the PR ready, as shipping used to.
      const pr = existing ?? (await openTaskPr(deps.github, slug, context, false));
      const phase = await evidencePhase(slug, pr.number, task.id, cwd);
      if ("stop" in phase) return phase.stop;
      const shown = "published" in phase ? { published: phase.published } : deps.evidence ? { evidence: "none" } : {};
      if (existing?.isDraft) await deps.github.markPrReady(slug, existing.number);
      return { outcome: "pass", detail: { prUrl: pr.url, readied: existing?.isDraft === true, ...shown } };
    } catch (error) {
      return { outcome: "fail", detail: { error: messageOf(error) } };
    }
  };
}

export const shipRunner = (github: GitHub): StageRunner => shipRunnerWith({ exec: realExec, github });
