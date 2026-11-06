// The assessment: one `ticket_assess` call over a workable ticket and its enrichment, then the scores in code (`ticketScore`). A ticket that
// is not workable is not assessed (validity comes first). Nothing is posted: the record goes to the ticket object's history and the
// recommendation (slice 5) reads it. A failed call is no assessment.
import type { Bands, CanonicalTicket, TicketContext, Weights } from "@hardness/contracts";

import { type AssessAnswer, type TicketScoreResult, ticketScore } from "../domain/ticket-score.ts";
import type { TicketEnrichment } from "./ticket-enrich.ts";
import { type TicketValidity, buildValidityContext } from "./ticket-validity.ts";

export interface AssessDeps {
  /** The one call of the `ticket_assess` decision pack on the flattened context. */
  decide(context: TicketContext): Promise<AssessAnswer>;
  /** Where the history lives, when the caller keeps it. */
  store?: { appendAssessment(key: string, entry: Record<string, unknown>): Promise<void> };
}

export interface AssessmentRecord extends TicketScoreResult {
  at: string;
}

export async function assessTicket(
  deps: AssessDeps,
  ticket: CanonicalTicket,
  enrichment: TicketEnrichment,
  validity: TicketValidity,
  config: { scoring: { weights: Weights; bands: Bands } },
  now: Date,
  extra: { cantReproduce?: boolean; candidates?: Array<{ id: string; kind: "open" | "closed" | "backlog"; title: string; text: string }> } = {},
): Promise<AssessmentRecord | null> {
  if (validity.outcome !== "workable") return null;
  try {
    const answer = await deps.decide(buildValidityContext(ticket, enrichment, extra.candidates ?? []));
    const result = ticketScore(answer, config, { cantReproduceNoReporter: extra.cantReproduce === true && validity.reporterReachable === false });
    const record: AssessmentRecord = { ...result, at: now.toISOString() };
    await deps.store?.appendAssessment(ticket.key, record as unknown as Record<string, unknown>);
    return record;
  } catch (error) {
    console.warn(`ticket assess: the decision failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}
