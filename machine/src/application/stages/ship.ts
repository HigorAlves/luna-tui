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
import { emptyCursor, loadCursor, saveCursor } from "../ship-cursor.ts";
import { type DeliverDeps, openTaskPr, pushBranch } from "./deliver.ts";
import type { ShipMonitor } from "./ship-monitor.ts";

export interface ShipDeps extends DeliverDeps {
  /** The Evidence Pack of the task: where it is read from and saved to, how it is published, where its local copy lives. Absent means ship without one. */
  evidence?: {
    load: (taskId: string) => Promise<EvidencePack | null>;
    save: (taskId: string, pack: EvidencePack) => Promise<void>;
    publish: PublishEvidence;
    store: { dirFor: (taskId: string, sha: string) => string };
  };
  /** The worktree's HEAD, the head the push just set; tests inject one. */
  headCommit?: (worktreePath: string) => Promise<string>;
  /** Watches the PR after the publish until it merges (ship-monitor.ts); absent, the stage passes once the PR is ready. */
  monitor?: ShipMonitor;
  /** Where the ship cursor lives; with it, a restarted run knows the pack is already published and goes straight to the monitor. */
  stateDir?: string;
}

export function shipRunnerWith(deps: ShipDeps): StageRunner {
  const slugOf = deps.slugOf ?? originSlugOf;
  const headOf = deps.headCommit ?? worktreeHead;
  /** The pack's turn at the gate: nothing to do (no pack), a stop (the head moved, the pack is incomplete), or what was published. */
  const evidencePhase = async (slug: string, number: number, taskId: string, worktreePath: string): Promise<{ stop: StageResult } | { published: Record<string, unknown>; note?: string } | { none: true }> => {
    const evidence = deps.evidence;
    if (!evidence) return { none: true };
    const pack = await evidence.load(taskId);
    if (!pack) return { none: true };
    // The head is what the push a moment ago set; GitHub's view of it can lag, so a difference there is a note, never a stop.
    const head = (await headOf(worktreePath)).trim();
    const seen = await deps.github.prHeadSha(slug, number).catch(() => null);
    const note = seen && seen !== head ? `GitHub shows ${seen.slice(0, 7)} as the PR head; the pushed head is ${head.slice(0, 7)}` : undefined;
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
    return { published: { comment: done.comment, assets: done.assets }, ...(note ? { note } : {}) };
  };
  return async (context) => {
    const { task } = context;
    if (!task.repoPath || !task.branch || !task.worktreePath) {
      return { outcome: "fail", detail: { error: "no branch to ship; the implementer never ran for real" } };
    }
    const cwd = task.worktreePath;
    // A restart re-runs this stage. The cursor names the PR already watched: ask GitHub about it first, so a merged PR
    // (whose branch the merge deleted) is neither pushed again nor opened anew.
    const cursor = deps.stateDir ? await loadCursor(deps.stateDir, task.id) : null;
    const resumed = cursor?.pr ?? null;
    if (resumed) {
      try {
        const state = await deps.github.prMerged(resumed.slug, resumed.number);
        const url = `https://github.com/${resumed.slug}/pull/${resumed.number}`;
        if (state.merged) {
          return { outcome: "pass", detail: { merged: { sha: state.mergedSha, at: state.mergedAt, by: cursor!.mergeRequested || cursor!.queued ? "machine" : "person" }, prUrl: url, number: resumed.number } };
        }
        if (state.state === "closed") {
          return { outcome: "escalated", detail: { escalation: "other", reason: "the PR was closed without a merge", options: [] } };
        }
      } catch (error) {
        return { outcome: "fail", detail: { error: messageOf(error) } };
      }
    }
    // The pack is already published on this very head: nothing new to push or publish.
    const head = cursor?.published ? (await headOf(cwd)).trim() : null;
    const already = head !== null && cursor?.published?.sha === head;
    if (!(resumed && already)) {
      const pushError = await pushBranch(deps.exec, task.branch, cwd);
      if (pushError) return { outcome: "fail", detail: { error: pushError } };
    }
    const slug = resumed?.slug ?? (await slugOf(cwd));
    if (!slug) return { outcome: "fail", detail: { error: "the worktree's origin is not a GitHub repository" } };
    try {
      const existing = await deps.github.findPr(slug, task.branch).catch((error: unknown) => {
        if (resumed) return null;
        throw error;
      });
      // Delivering was skipped (an older task): open the PR ready, as shipping used to. A resumed run never opens another.
      const pr = existing ?? (resumed ? { url: `https://github.com/${resumed.slug}/pull/${resumed.number}`, number: resumed.number, isDraft: false } : await openTaskPr(deps.github, slug, context, false));
      const phase: Awaited<ReturnType<typeof evidencePhase>> = already ? { published: { resumed: true } } : await evidencePhase(slug, pr.number, task.id, cwd);
      if ("stop" in phase) return phase.stop;
      if (deps.stateDir && "published" in phase && !already) {
        const sha = (await headOf(cwd)).trim();
        await saveCursor(deps.stateDir, task.id, { ...(cursor ?? emptyCursor({ slug, number: pr.number })), pr: { slug, number: pr.number }, published: { sha } });
      }
      const shown = "published" in phase ? { published: phase.published, ...(phase.note ? { note: phase.note } : {}) } : deps.evidence ? { evidence: "none" } : {};
      if (existing?.isDraft) await deps.github.markPrReady(slug, existing.number);
      const detail = { prUrl: pr.url, readied: existing?.isDraft === true, ...shown };
      if (!deps.monitor) return { outcome: "pass", detail };
      const watched = await deps.monitor(context, { slug, number: pr.number, url: pr.url });
      return watched.outcome === "pass" ? { ...watched, detail: { ...detail, ...watched.detail } } : watched;
    } catch (error) {
      return { outcome: "fail", detail: { error: messageOf(error) } };
    }
  };
}

export const shipRunner = (github: GitHub): StageRunner => shipRunnerWith({ exec: realExec, github });
