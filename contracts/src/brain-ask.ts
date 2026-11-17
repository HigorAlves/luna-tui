// The brain_ask pack's answer, and the check that drops a cite of a row the machine never showed.
// Its context (the question and the rows) is in stage.ts, with the other contexts.
import { z } from "zod";

import type { BrainAskContext, BrainAskRow } from "./stage.ts";

export const BrainAskAnswer = z.object({
  /** False when the rows do not hold the answer. */
  known: z.boolean(),
  reply: z.string().max(1200),
  /** Slugs of the rows the reply rests on, copied verbatim. */
  cites: z.array(z.string().max(300)).max(10),
});
export type BrainAskAnswer = z.infer<typeof BrainAskAnswer>;

/** The cites that name a row of the context, once each and in the answer's order, and the ones that do not. Pure: the machine drops a cite of a row it never showed. */
export function brainAskCites(answer: BrainAskAnswer, context: BrainAskContext): { cites: BrainAskRow[]; dropped: string[] } {
  const cites: BrainAskRow[] = [];
  const dropped: string[] = [];
  const seen = new Set<string>();
  for (const slug of answer.cites) {
    if (seen.has(slug)) continue;
    seen.add(slug);
    const row = context.rows.find((candidate) => candidate.slug === slug);
    if (row) cites.push(row);
    else dropped.push(slug);
  }
  return { cites, dropped };
}
