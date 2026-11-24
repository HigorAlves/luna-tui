// The recommendation where the scores decide: pure. Do now, schedule, decline or needs decision; `split` is named for an XL ticket and left to
// wave 15's decomposition. Where the rule cannot tell it answers null, and the typed decision `ticket_recommend` is asked (ticket-drafts.ts).
import type { TicketScoreResult } from "./ticket-score.ts";

export type Recommendation = "do_now" | "schedule" | "decline" | "needs_decision" | "split";

/** Cost of delay over cost of doing: at or above this, doing it now pays for itself. */
export const NOW_AT = 1;
/** At or above this a ticket is worth doing, if not now. */
export const SCHEDULE_AT = 0.6;
/** Below this, for a P3, the ticket costs more than it is worth. */
export const DECLINE_BELOW = 0.5;

export function recommend(score: TicketScoreResult): { action: Recommendation; reason: string } | null {
  if (score.knockOut?.action === "p0") return { action: "do_now", reason: `flagged ${score.knockOut.flag.replace(/_/g, " ")}` };
  if (score.parked) return { action: "needs_decision", reason: "it cannot be reproduced and its reporter cannot be asked" };
  if (score.blastRadius === "high") return { action: "needs_decision", reason: "a high blast radius: a person decides" };
  if (score.size === "XL") return { action: "split", reason: "an XL ticket is split before it is planned" };
  const urgent = score.priority === "P0" || score.priority === "P1";
  if (urgent) return score.score >= NOW_AT ? { action: "do_now", reason: "cost of delay is at least the cost of doing" } : { action: "needs_decision", reason: "urgent, but costing more to do than to delay" };
  if (score.score >= SCHEDULE_AT) return { action: "schedule", reason: "worth doing, not urgent" };
  if (score.priority === "P3" && score.score < DECLINE_BELOW) return { action: "decline", reason: "low priority and costly" };
  return null;
}
