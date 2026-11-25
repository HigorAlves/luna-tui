// What later happens to the threads a review answered says whether the decisions behind the answers were right (RFC 0005 wave 7).
// When a review ships, the machine keeps beside the card which `thread_settle` records resolved a thread and which `comment_intent`
// records read an acknowledgement. Three facts settle them: a thread we resolved that is open again was settled wrongly; one still
// resolved when the PR merges was settled rightly; an acknowledged thread a later commit addressed was read rightly.
// Left out, because no cheap fact tells them: the `addressed: false` of a thread we left open (a later fix does not say it was right
// to leave it) and the `reply_holds` of a thread nobody reopened before the PR closed unmerged.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Label, TruthSink } from "./decision-truth.ts";
import type { GitHub } from "./github.ts";

export interface ThreadMemory {
  /** Threads the machine resolved on a decision's word, with the record that said so and which answer it was. */
  resolved: Array<{ threadId: string; recordId: string; settle: "fixed" | "reply_holds" }>;
  /** Threads left open because the author's reply was read as an acknowledgement, with comment_intent's record. */
  acknowledged: Array<{ threadId: string; recordId: string }>;
}

const MAX_KEPT = 200;
const fileOf = (stateDir: string, taskId: string) => join(stateDir, "tasks", taskId, "review-threads.json");
const empty = (): ThreadMemory => ({ resolved: [], acknowledged: [] });

async function load(stateDir: string, taskId: string): Promise<ThreadMemory> {
  try {
    const parsed = JSON.parse(await readFile(fileOf(stateDir, taskId), "utf8")) as Partial<ThreadMemory>;
    return { resolved: Array.isArray(parsed.resolved) ? parsed.resolved : [], acknowledged: Array.isArray(parsed.acknowledged) ? parsed.acknowledged : [] };
  } catch {
    return empty();
  }
}

async function save(stateDir: string, taskId: string, memory: ThreadMemory): Promise<void> {
  const file = fileOf(stateDir, taskId);
  await mkdir(join(stateDir, "tasks", taskId), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify({ resolved: memory.resolved.slice(-MAX_KEPT), acknowledged: memory.acknowledged.slice(-MAX_KEPT) }));
  await rename(tmp, file);
}

/** Adds what a shipped review decided about its threads to what the card already keeps. Never throws. */
export async function keepThreadDecisions(stateDir: string, taskId: string, add: Partial<ThreadMemory>): Promise<void> {
  try {
    if (!add.resolved?.length && !add.acknowledged?.length) return;
    const memory = await load(stateDir, taskId);
    const fresh = <T extends { threadId: string }>(old: T[], more: T[] | undefined): T[] => [...old.filter((o) => !more?.some((m) => m.threadId === o.threadId)), ...(more ?? [])];
    await save(stateDir, taskId, { resolved: fresh(memory.resolved, add.resolved), acknowledged: fresh(memory.acknowledged, add.acknowledged) });
  } catch (error) {
    console.warn(`review truth: could not keep the thread decisions of ${taskId}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const settleLabel = (settle: "fixed" | "reply_holds", right: boolean): Label => (settle === "fixed" ? { addressed: { value: right } } : { reply_holds: { value: right } });

/** A re-review read the PR again: `open` are our threads that are open now (resolved ones are not listed), `fixed` those it settled as fixed. Never throws. */
export async function learnFromRereview(deps: { stateDir: string; truth: TruthSink }, taskId: string, seen: { open: ReadonlySet<string>; fixed: ReadonlySet<string> }): Promise<void> {
  try {
    const memory = await load(deps.stateDir, taskId);
    const next = empty();
    let changed = false;
    for (const r of memory.resolved) {
      if (!seen.open.has(r.threadId)) {
        next.resolved.push(r);
        continue;
      }
      changed = true;
      await deps.truth.learned({ pack: "thread_settle", recordId: r.recordId, label: settleLabel(r.settle, false), kind: "outcome", source: "thread_reopened", taskId });
    }
    for (const a of memory.acknowledged) {
      if (!seen.fixed.has(a.threadId)) {
        next.acknowledged.push(a);
        continue;
      }
      changed = true;
      await deps.truth.learned({ pack: "comment_intent", recordId: a.recordId, label: { intent: { choice: "acknowledgement" } }, kind: "outcome", source: "thread_fixed_after_ack", taskId });
    }
    if (changed) await save(deps.stateDir, taskId, next);
  } catch (error) {
    console.warn(`review truth: re-review of ${taskId}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** The PR merged: a thread we resolved that is still resolved confirms its decision, one open now contradicts it. A card that kept nothing is left alone; threads that cannot be read keep the memory. Never throws. */
export async function learnAtMerge(deps: { stateDir: string; truth: TruthSink; github: Pick<GitHub, "prThreads"> }, taskId: string, slug: string, number: number): Promise<void> {
  try {
    const memory = await load(deps.stateDir, taskId);
    if (memory.resolved.length === 0) return;
    const open = new Set((await deps.github.prThreads(slug, number)).map((t) => t.id));
    for (const r of memory.resolved) {
      const reopened = open.has(r.threadId);
      await deps.truth.learned({ pack: "thread_settle", recordId: r.recordId, label: settleLabel(r.settle, !reopened), kind: "outcome", source: reopened ? "thread_reopened" : "pr_merged", taskId });
    }
    await save(deps.stateDir, taskId, empty());
  } catch (error) {
    console.warn(`review truth: merge of ${taskId}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
