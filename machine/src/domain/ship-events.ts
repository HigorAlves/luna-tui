import type { ShipEventClass } from "@hardness/contracts";

export interface ShipEventFacts {
  mergeable: string;
  mergeState: string;
  /** A freeze window of the freeze source holds now (a source that could not be read counts as frozen). */
  frozen: boolean;
  /** Open PRs this one says it depends on or is blocked by. */
  openDependencies: number;
}

/** The classes GitHub's facts decide, from one poll. `parent_merged` and `parent_changed` wait for wave 15 (stacked PRs). */
export function shipEvents(facts: ShipEventFacts): ShipEventClass[] {
  const out: ShipEventClass[] = [];
  if (facts.mergeable === "CONFLICTING" || facts.mergeState === "DIRTY") out.push("conflict");
  if (facts.mergeState === "BEHIND") out.push("base_moved");
  if (facts.frozen) out.push("freeze");
  if (facts.openDependencies > 0) out.push("blocked_by_other_pr");
  return out;
}
