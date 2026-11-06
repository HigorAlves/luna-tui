// The ship stage, the feature route's `shipping`: the merge and nothing else. The watch (ship-watch.ts, at `awaiting_ship`) says a
// merge is due; this stage decides again on GitHub's facts at that moment (the readiness script, the head GitHub shows now) and merges
// with the head's sha as the guard. What it records as merged is the merge commit GitHub reports, never the PR head. A PR that is not
// ready any more is handed back to the watch (`notReady`), and nothing in a PR comment, a review or a log can reach this stage.
import { type GitHub, messageOf } from "../github.ts";
import type { StageContext, StageResult, StageRunner } from "../ports.ts";
import { type ShipCursor, loadCursor, saveCursor } from "../ship-cursor.ts";
import { type ShipFacts, type ShipMonitorDeps, readShipFacts, settleDecisions } from "./ship-monitor.ts";

/** How long the machine waits for the merge queue to merge a PR it queued, before the watch looks at it again. */
export const MERGE_QUEUE_WAIT_MS = 6 * 3_600_000;
/** Reads of the merge commit after a merge: GitHub can lag the merge it just made. */
const MERGE_READS = 3;
const MERGE_READ_PAUSE_MS = 1000;
const MERGE_ATTEMPTS = 2;

export interface MergeDeps extends Pick<ShipMonitorDeps, "github" | "policies" | "evidence" | "truth" | "stateDir" | "pollMs" | "sleep" | "now" | "readCodeowners"> {
  /** The facts of one poll; default `readShipFacts`. Tests inject one. */
  readFacts?: (context: StageContext, ref: { slug: string; number: number }, cursor: ShipCursor) => Promise<ShipFacts | null>;
  /** What the merge settles (the decisions waiting on the PR's outcome); default `settleDecisions`. */
  settle?: (taskId: string, cursor: ShipCursor, slug: string, number: number) => Promise<void>;
}

export function mergeRunner(deps: MergeDeps): StageRunner {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? (() => new Date());
  const readFacts = deps.readFacts ?? ((context, ref, cursor) => readShipFacts(deps, context, ref, cursor, now));
  const settle = deps.settle ?? ((taskId, cursor, slug, number) => settleDecisions(deps, taskId, cursor, slug, number));
  const notReady = (reason: string): StageResult => ({ outcome: "fail", detail: { notReady: true, reason } });

  return async (context) => {
    const { task, signal } = context;
    const cursor = await loadCursor(deps.stateDir, task.id);
    // No cursor: nothing is being watched. The watch finds the PR itself.
    if (!cursor) return notReady("no PR is being watched");
    const { slug, number } = cursor.pr;
    const url = `https://github.com/${slug}/pull/${number}`;
    const recorded = async (state: Awaited<ReturnType<GitHub["prMerged"]>>, note?: string): Promise<StageResult> => {
      await settle(task.id, cursor, slug, number).catch(() => {});
      return { outcome: "pass", detail: { merged: { sha: state.mergedSha ?? null, at: state.mergedAt, by: cursor.mergeRequested || cursor.queued ? "machine" : "person" }, prUrl: url, number, ...(note ? { note } : {}) } };
    };
    /** The PR's own state, read first and last: a merge a person made, a PR closed. Null when it is still open. */
    const ended = async (): Promise<StageResult | null> => {
      const state = await deps.github.prMerged(slug, number);
      if (state.merged) return recorded(state);
      if (state.state === "closed") return { outcome: "escalated", detail: { escalation: "other", reason: "the PR was closed without a merge", options: [] } };
      return null;
    };
    /** Waits for the queue to merge what the machine queued: pass when it does, notReady (queue flag cleared) after the wait. */
    const queued = async (): Promise<StageResult> => {
      const began = now().getTime();
      let waited = 0;
      for (;;) {
        const result = await ended().catch(() => null);
        if (result) return result;
        if (signal.aborted) return { outcome: "fail", detail: { error: "aborted" } };
        if (waited >= MERGE_QUEUE_WAIT_MS || now().getTime() - began >= MERGE_QUEUE_WAIT_MS) {
          cursor.queued = false;
          await saveCursor(deps.stateDir, task.id, cursor);
          return notReady("the merge queue did not merge the PR in six hours");
        }
        await sleep(deps.pollMs);
        waited += deps.pollMs;
      }
    };

    try {
      const done = await ended();
      if (done) return done;
      if (cursor.queued) return await queued();
      const facts = await readFacts(context, { slug, number }, cursor);
      if (!facts) return notReady("GitHub shows no such PR right now");
      // Decided again on what GitHub shows now, at the head it shows now.
      if (!facts.readiness.canAutoMerge || !facts.head) return notReady(facts.readiness.reason);
      for (let attempt = 1; ; attempt++) {
        try {
          cursor.mergeRequested = true;
          await saveCursor(deps.stateDir, task.id, cursor);
          const result = await deps.github.mergePr(slug, number, { sha: facts.head });
          if (result && "queued" in result) {
            cursor.queued = true;
            await saveCursor(deps.stateDir, task.id, cursor);
            return await queued();
          }
          break;
        } catch (error) {
          cursor.mergeRequested = false;
          await saveCursor(deps.stateDir, task.id, cursor);
          if (attempt >= MERGE_ATTEMPTS) return { outcome: "escalated", detail: { escalation: "other", reason: `the merge failed twice: ${messageOf(error)}`, options: [] } };
          await sleep(deps.pollMs);
        }
      }
      // The merge commit GitHub reports; GitHub can lag, so a few reads. Never the PR head.
      let last = await deps.github.prMerged(slug, number);
      for (let read = 1; !(last.merged && last.mergedSha) && read < MERGE_READS; read++) {
        await sleep(MERGE_READ_PAUSE_MS);
        last = await deps.github.prMerged(slug, number);
      }
      if (!last.merged) return { outcome: "pass", detail: { merged: { sha: null, at: now().toISOString(), by: "machine" }, prUrl: url, number, note: "GitHub did not report the merge commit" } };
      return await recorded(last, last.mergedSha ? undefined : "GitHub did not report the merge commit");
    } catch (error) {
      return { outcome: "fail", detail: { error: messageOf(error) } };
    }
  };
}

/** The shipping stage when the real stages are not built (agents off): it merges nothing and passes, as the other stubs do. */
export const shipRunner = (_github: GitHub): StageRunner => async () => ({ outcome: "pass", detail: { note: "agents are off: nothing was merged" } });
