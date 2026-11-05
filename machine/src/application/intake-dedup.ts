// Intake's duplicate check: a shortlist by script (`similar`), one typed decision over it (`intake_dedup`), and the outcome by the
// repo's `dedup` thresholds. The judgement is the pack's; everything else is a fact. Nothing here posts or merges: the caller acts on the outcome.
import { type DedupContext, FACTORY_DEFAULTS } from "@hardness/contracts";

import { safe } from "../domain/evidence-markdown.ts";
import { type Candidate, type Near, SHORTLIST, similar } from "../domain/similarity.ts";

export type DedupAnswer = Record<`slot${1 | 2 | 3 | 4 | 5}`, { choice: "same" | "related" | "different"; confidence: number } | undefined>;

export interface DedupDeps {
  /** The one call of the `intake_dedup` decision pack, on the flattened context. */
  decide(context: DedupContext): Promise<DedupAnswer>;
}

export interface DedupOutcome {
  /** A confident same: the card is a report of this one. */
  duplicate: Near | null;
  /** The cards to link as related. */
  related: Near[];
  /** Candidates a person is asked about: the judgement was under the asking bar. */
  ask: Near[];
}

export const NO_OUTCOME: DedupOutcome = { duplicate: null, related: [], ask: [] };

export interface Thresholds {
  duplicate: number;
  related: number;
  askBelow: number;
}

export const thresholdsOf = (dedup: { duplicate: number; related: number; ask_below: number } = FACTORY_DEFAULTS.dedup): Thresholds => ({ duplicate: dedup.duplicate, related: dedup.related, askBelow: dedup.ask_below });

export function outcomeOf(shortlist: Near[], answer: DedupAnswer, t: Thresholds): DedupOutcome {
  let duplicate: { near: Near; confidence: number } | null = null;
  const related: Near[] = [];
  const ask: Near[] = [];
  shortlist.slice(0, SHORTLIST).forEach((near, i) => {
    const a = answer[`slot${i + 1}` as keyof DedupAnswer];
    if (!a || a.choice === "different") return;
    if (a.confidence < t.askBelow) ask.push(near);
    else if (a.choice === "same" && a.confidence >= t.duplicate) {
      if (!duplicate || a.confidence > duplicate.confidence) duplicate = { near, confidence: a.confidence };
    } else if (a.confidence >= t.related) related.push(near);
  });
  const dup = duplicate as { near: Near; confidence: number } | null;
  return { duplicate: dup?.near ?? null, related: related.filter((n) => n.id !== dup?.near.id), ask };
}

const SUMMARY = 300;

/** The shortlist of `candidates`, judged in one call. No similar card means no call; a failed call means no outcome, so a card is never held up by it. */
export async function intakeDedup(
  deps: DedupDeps,
  card: { title: string; text: string; repo: string | null },
  candidates: Candidate[],
  options: { now: Date; dedup?: { duplicate: number; related: number; ask_below: number; lookback_days: number } },
): Promise<DedupOutcome> {
  const dedup = options.dedup ?? FACTORY_DEFAULTS.dedup;
  const shortlist = similar(card, candidates, { now: options.now, lookbackDays: dedup.lookback_days });
  if (shortlist.length === 0) return NO_OUTCOME;
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const context: DedupContext = {
    title: safe(card.title).slice(0, 500),
    text: safe(card.text).slice(0, 4000),
    candidates: shortlist.map((near, i) => {
      const c = byId.get(near.id)!;
      return { slot: i + 1, kind: c.kind, title: safe(c.title).slice(0, 500), summary: safe(c.text).slice(0, SUMMARY) };
    }),
  };
  try {
    return outcomeOf(shortlist, await deps.decide(context), thresholdsOf(dedup));
  } catch (error) {
    console.warn(`intake dedup: the decision failed: ${error instanceof Error ? error.message : String(error)}`);
    return NO_OUTCOME;
  }
}
