import type { ShipEventClass } from "@hardness/contracts";

export interface ShipEventFacts {
  mergeable: string;
  mergeState: string;
  /** A freeze window of the freeze source holds now (a source that could not be read counts as frozen). */
  frozen: boolean;
  /** Open PRs this one says it depends on or is blocked by. */
  openDependencies: number;
  /** A stacked card's parent as GitHub shows it now, and the commit this card's branch was last cut from or rebased onto. Absent or null: not stacked. */
  stack?: { state: "open" | "merged" | "gone"; head: string | null; recordedBase: string | null } | null;
}

/** The classes GitHub's facts decide, from one poll. `parent_merged` and `parent_changed` are facts of a stacked card's parent; its base is the parent, so it never has `base_moved`. */
export function shipEvents(facts: ShipEventFacts): ShipEventClass[] {
  const out: ShipEventClass[] = [];
  if (facts.mergeable === "CONFLICTING" || facts.mergeState === "DIRTY") out.push("conflict");
  const stack = facts.stack ?? null;
  if (!stack && facts.mergeState === "BEHIND") out.push("base_moved");
  if (stack?.state === "merged") out.push("parent_merged");
  else if (stack?.state === "open" && stack.head !== null && stack.recordedBase !== null && stack.head !== stack.recordedBase) out.push("parent_changed");
  if (facts.frozen) out.push("freeze");
  if (facts.openDependencies > 0) out.push("blocked_by_other_pr");
  return out;
}
