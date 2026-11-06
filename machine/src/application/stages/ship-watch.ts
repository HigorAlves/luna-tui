// The ship watch, the feature route's runner of `awaiting_ship`: the PR was opened as a draft at delivering, so the
// watch pushes any last commits, makes sure the task's Evidence Pack is on the PR (published and the PR ready), and
// then runs the monitor, which watches the PR until a merge is due, a person is needed or the PR ends. The merge is
// the next stage's (`shipping`, ship.ts). Git on the host for the push, the GitHub port for the PR. The pack is
// published only once it is complete and its commit is the PR head: a head that moved sends the task back to Evidence.
import type { EvidencePack } from "@hardness/contracts";

import { headCommit as worktreeHead, originSlugOf } from "../../adapters/git/worktree.ts";
import { packComplete, repairPack } from "../../domain/evidence-pack.ts";
import { type PublishEvidence, publishAndReady } from "../evidence-publish.ts";
import { messageOf } from "../github.ts";
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

export function shipWatchRunner(deps: ShipDeps): StageRunner {
  const slugOf = deps.slugOf ?? originSlugOf;
  const headOf = deps.headCommit ?? worktreeHead;
  /** The pack's turn at the gate: nothing to do (no pack), a stop (the head moved, the pack is incomplete), or what was published. */
  const evidencePhase = async (slug: string, number: number, taskId: string, worktreePath: string, repoPath: string | null, approved: boolean, draft: boolean): Promise<{ stop: StageResult } | { published: Record<string, unknown>; readied?: boolean; note?: string } | { none: true }> => {
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
    // What a script can fix is fixed before the stage fails on an incomplete pack.
    let shown = pack;
    const complete = packComplete(pack, head);
    if (!complete.ok) {
      const fixed = repairPack(pack, complete.problems);
      const after = packComplete(fixed.pack, head);
      if (fixed.unfixed.length > 0 || !after.ok) return { stop: { outcome: "fail", detail: { error: `the evidence pack is not complete: ${[...fixed.unfixed, ...after.problems].join("; ")}` } } };
      shown = fixed.pack;
    }
    // The one publisher: it checks the pack against the head, puts it on the PR, saves it, notes the head in the cursor and marks a draft ready.
    const done = await publishAndReady({ github: deps.github, publish: evidence.publish, save: evidence.save, localDir: evidence.store.dirFor, ...(deps.stateDir ? { stateDir: deps.stateDir } : {}) }, { task: { id: taskId, repoPath }, slug, number, headSha: head, draft, pack: shown, approved });
    if (!done.published) return { stop: { outcome: "fail", detail: { error: done.reason } } };
    return { published: { comment: done.comment, assets: done.assets }, readied: done.readied, ...(done.edited ? { edited: done.edited } : {}), ...(note ? { note } : {}) };
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
          // GitHub's own `closed` state, never a comment's word: the pipeline archives the card (`pr_closed`).
          return { outcome: "fail", detail: { prClosed: true } };
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
      const phase: Awaited<ReturnType<typeof evidencePhase>> = already ? { published: { resumed: true } } : await evidencePhase(slug, pr.number, task.id, cwd, task.repoPath ?? null, context.approvals.some((a) => a.kind === "awaiting_ship" && a.decision === "approved" && a.requested?.gate !== "ship_approval"), existing?.isDraft === true);
      if ("stop" in phase) return phase.stop;
      if (deps.stateDir && "published" in phase && !already) {
        const sha = (await headOf(cwd)).trim();
        await saveCursor(deps.stateDir, task.id, { ...(cursor ?? emptyCursor({ slug, number: pr.number })), pr: { slug, number: pr.number }, published: { sha } });
      }
      if ("published" in phase && !already) await context.emit?.("evidence.published", {}).catch(() => {});
      if ("edited" in phase && phase.edited) await context.emit?.("evidence.edited", { ...(phase.edited as { sha: string; bytes: number }) }).catch(() => {});
      const shown = "published" in phase ? { published: phase.published, ...(phase.note ? { note: phase.note } : {}) } : deps.evidence ? { evidence: "none" } : {};
      if (existing?.isDraft && !("published" in phase && phase.readied === true && !already)) await deps.github.markPrReady(slug, existing.number);
      const detail = { prUrl: pr.url, readied: existing?.isDraft === true, ...shown };
      if (!deps.monitor) return { outcome: "pass", detail };
      const watched = await deps.monitor(context, { slug, number: pr.number, url: pr.url });
      return watched.outcome === "pass" ? { ...watched, detail: { ...detail, ...watched.detail } } : watched;
    } catch (error) {
      return { outcome: "fail", detail: { error: messageOf(error) } };
    }
  };
}

