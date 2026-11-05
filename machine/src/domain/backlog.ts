// The backlog's rank, pure: cost of delay over cost of doing (wave 8's `wsjf`), ties by age, and which items have gone stale.
import { type BacklogScores, type BacklogSize, costOfDelay, costOfDoing, wsjf } from "@hardness/contracts";

const DAY = 86_400_000;
/** A size as the three scores cost of doing sums: complexity, blast radius, regression. */
const DOING: Record<BacklogSize, { complexity: number; blastRadius: number; regression: number }> = {
  XS: { complexity: 1, blastRadius: 1, regression: 1 },
  S: { complexity: 1, blastRadius: 1, regression: 2 },
  M: { complexity: 2, blastRadius: 2, regression: 2 },
  L: { complexity: 3, blastRadius: 3, regression: 2 },
  XL: { complexity: 3, blastRadius: 3, regression: 3 },
};
/** The demand sub-score tops out here, as every score does. */
const SCORE_MAX = 3;

export interface Item {
  id: string;
  title: string;
  scores: BacklogScores;
  size: BacklogSize;
  /** Reports of it; 1 for the one that added it. */
  demand: number;
  addedAt: Date;
  assessedAt: Date;
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/** Wave 8's cost of delay: urgency is the `time` score; compounding is the mean of `who`, `what`, `impact` and the demand score, which rises by one
 *  for each report beyond the first and stops at the top level. */
export function costOfDelayOf(item: Pick<Item, "scores" | "demand">): number {
  const { who, what, impact, time } = item.scores;
  const demand = Math.min(SCORE_MAX, item.scores.demand + Math.max(0, item.demand - 1));
  return round3(costOfDelay({ urgency: time, compounding: (who + what + impact + demand) / 4 }));
}

export const costOfDoingOf = (item: Pick<Item, "size">): number => costOfDoing(DOING[item.size]);

export interface Ranked {
  id: string;
  score: number;
  stale: boolean;
}

export function rankBacklog(items: Item[], options: { now: Date; staleDays: number }): Ranked[] {
  const since = options.now.getTime() - options.staleDays * DAY;
  return items
    .map((item) => ({ item, score: round3(wsjf({ costOfDelay: costOfDelayOf(item), costOfDoing: costOfDoingOf(item) })) }))
    .sort((a, b) => b.score - a.score || a.item.addedAt.getTime() - b.item.addedAt.getTime() || (a.item.id < b.item.id ? -1 : 1))
    .map(({ item, score }) => ({ id: item.id, score, stale: item.assessedAt.getTime() < since }));
}
