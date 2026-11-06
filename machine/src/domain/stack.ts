// The dependency rule (RFC 0006 wave 15): a card starts when every card it depends on has merged or has an open PR, and it
// stacks on the one open dependency whose branch holds the others. Pure: the pipeline reads the facts, this decides.
import type { ArchiveReason, TaskState } from "@hardness/contracts";

/** What the rule needs to know of a dependency (the pipeline reads it from the card's own rows and events). */
export interface DepFact {
  id: string;
  repoPath: string | null;
  branch: string | null;
  state: TaskState;
  archiveReason: ArchiveReason | null;
  /** A passed `delivering` run named a PR number. */
  hasOpenPr: boolean;
  /** The card is `closed`, or at `reviewing_memory` with a merge on record. */
  merged: boolean;
  base: { card: string; branch: string } | null;
  /** The card this one was merged into as a duplicate. */
  mergedInto: string | null;
}

export type NotReady = "waiting" | "dependency_archived" | "diverging" | "too_deep" | "missing" | "cycle";
export type Schedulable = { ok: true; base: { card: string; branch: string } | null } | { ok: false; reason: NotReady; waitingOn: string[] };

const ended = (state: TaskState): boolean => state === "closed" || state === "archived";

/** The id followed by the cards it is stacked on, nearest first; stops at a repeat, so a loop cannot run on. */
function chainOf(start: string, deps: ReadonlyMap<string, DepFact>): { ids: string[]; loops: boolean } {
  const ids: string[] = [];
  let at: string | undefined = start;
  while (at !== undefined) {
    if (ids.includes(at)) return { ids, loops: true };
    ids.push(at);
    at = deps.get(at)?.base?.card;
  }
  return { ids, loops: false };
}

export function schedulable(card: { id: string; repoPath: string | null; dependsOn: readonly string[] }, deps: ReadonlyMap<string, DepFact>, rule: { maxDepth: number }): Schedulable {
  const cycle = (waitingOn: string[]): Schedulable => ({ ok: false, reason: "cycle", waitingOn });
  if (card.dependsOn.includes(card.id)) return cycle([card.id]);
  const missing: string[] = [];
  const archived: string[] = [];
  const waiting: string[] = [];
  const open: DepFact[] = [];
  for (const id of card.dependsOn) {
    let fact = deps.get(id);
    if (fact?.mergedInto) {
      const into = deps.get(fact.mergedInto);
      if (!into) {
        missing.push(fact.mergedInto);
        continue;
      }
      fact = into;
    }
    if (!fact) {
      missing.push(id);
      continue;
    }
    if (fact.state === "archived" && !fact.merged) {
      archived.push(id);
      continue;
    }
    if (fact.merged) continue;
    if (!ended(fact.state) && fact.hasOpenPr) {
      if (!open.some((o) => o.id === fact.id)) open.push(fact);
      continue;
    }
    waiting.push(id);
  }
  if (missing.length > 0) return { ok: false, reason: "missing", waitingOn: missing };
  if (archived.length > 0) return { ok: false, reason: "dependency_archived", waitingOn: archived };
  if (waiting.length > 0) return { ok: false, reason: "waiting", waitingOn: waiting };

  const candidates = open.filter((f) => f.branch !== null && f.repoPath === card.repoPath);
  for (const f of candidates) {
    const chain = chainOf(f.id, deps);
    if (chain.loops || chain.ids.includes(card.id)) return cycle([f.id]);
  }
  if (candidates.length === 0) return { ok: true, base: null };
  const chosen = candidates.find((c) => {
    const held = new Set(chainOf(c.id, deps).ids);
    return candidates.every((o) => held.has(o.id));
  });
  if (!chosen) return { ok: false, reason: "diverging", waitingOn: candidates.map((c) => c.id) };
  if (chainOf(chosen.id, deps).ids.length + 1 > rule.maxDepth) return { ok: false, reason: "too_deep", waitingOn: [chosen.id] };
  return { ok: true, base: { card: chosen.id, branch: chosen.branch! } };
}
