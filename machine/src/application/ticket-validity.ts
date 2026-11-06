// Validity before assessment: one `ticket_validity` call over the ticket and its enrichment, then the outcome by script over the answers and
// the pack's bar. Workable, needs info (with exactly what is missing, in fixed words), duplicate (of which card), or not ours. Only a workable
// ticket is assessed. A failed call is no outcome (null): nothing is assessed and nothing is posted on a guess.
import type { CanonicalTicket, TicketContext } from "@hardness/contracts";

import { safe } from "../domain/evidence-markdown.ts";
import type { Near } from "../domain/similarity.ts";
import type { TicketEnrichment } from "./ticket-enrich.ts";

type YesNo = { value: boolean; p: number };
type Choice = { choice: string; confidence: number };

export interface ValidityAnswer {
  goal: YesNo;
  criteria: YesNo;
  scope: YesNo;
  duplicate: Choice;
  project: YesNo;
  reporter: YesNo;
}

export interface TicketValidity {
  outcome: "workable" | "needs_info" | "duplicate" | "not_ours";
  /** What a needs-info comment asks for, in fixed words. */
  missing: string[];
  /** The id of the card or backlog item this is a duplicate of. */
  duplicateOf: string | null;
  /** Whether the reporter can be asked; null when the pack did not say confidently. Read by the assessment's knock-outs. */
  reporterReachable: boolean | null;
  /** Whether the pack was sure the ticket has repro steps or acceptance criteria (true), sure it has none (false), or unsure (null). */
  criteriaMet: boolean | null;
}

/** The pack's bar: an answer is taken only when its confidence is at least this (the pack's `proceed` policy). */
export const VALIDITY_BAR = 0.7;

const sure = (a: YesNo): boolean | null => (a.p >= VALIDITY_BAR ? true : a.p <= 1 - VALIDITY_BAR ? false : null);

export function validityOf(answer: ValidityAnswer, shortlist: Near[], bar = VALIDITY_BAR): TicketValidity {
  const reporterReachable = sure(answer.reporter);
  const slot = /^slot([1-5])$/.exec(answer.duplicate.choice);
  const dup = slot ? shortlist[Number(slot[1]) - 1] : undefined;
  if (dup && answer.duplicate.confidence >= bar) return { outcome: "duplicate", missing: [], duplicateOf: dup.id, reporterReachable, criteriaMet: sure(answer.criteria) };
  if (sure(answer.project) === false) return { outcome: "not_ours", missing: [], duplicateOf: null, reporterReachable, criteriaMet: sure(answer.criteria) };
  const missing: string[] = [];
  if (sure(answer.goal) !== true) missing.push("what outcome is wanted");
  if (sure(answer.criteria) !== true) missing.push("steps to reproduce it, or what done looks like");
  if (sure(answer.scope) !== true) missing.push("a bounded scope: one change a team could finish");
  if (sure(answer.project) !== true) missing.push("which project or repository this is for");
  return { outcome: missing.length ? "needs_info" : "workable", missing, duplicateOf: null, reporterReachable, criteriaMet: sure(answer.criteria) };
}

const text = (s: string, max: number) => safe(s).slice(0, max);

/** The ticket and its enrichment as the pack reads them: every word of it flattened by `safe()` and capped. `candidates` are the shortlist's cards, in its order. */
export function buildValidityContext(ticket: CanonicalTicket, enrichment: TicketEnrichment, candidates: Array<{ id: string; kind: "open" | "closed" | "backlog"; title: string; text: string }>): TicketContext {
  const byId = new Map(candidates.map((c) => [c.id, c]));
  return {
    key: text(ticket.key, 200),
    title: text(ticket.title, 500),
    description: text(ticket.description, 4000),
    type: ticket.type ? text(ticket.type, 120) : null,
    priority: ticket.priority ? text(ticket.priority, 120) : null,
    reporter: ticket.reporter ? text(ticket.reporter.name ?? ticket.reporter.id, 120) : null,
    reachable: ticket.reporter !== null,
    labels: ticket.labels.slice(0, 30).map((l) => text(l, 120)),
    sprint: ticket.sprint ? text(ticket.sprint, 120) : null,
    dueAt: ticket.dueAt ? text(ticket.dueAt, 60) : null,
    comments: ticket.comments.slice(0, 10).map((c) => ({ author: text(c.author, 120), text: text(c.text, 500) })),
    linked: enrichment.linked.slice(0, 20).map((l) => text(l, 200)),
    epic: enrichment.epic ? text(enrichment.epic, 200) : null,
    recent: enrichment.recent.slice(0, 10).map((r) => ({ key: text(r.key, 200), title: text(r.title, 300) })),
    files: enrichment.files.slice(0, 10).map((f) => text(f, 300)),
    candidates: enrichment.shortlist.slice(0, 5).flatMap((near, i) => {
      const c = byId.get(near.id);
      return c ? [{ slot: i + 1, kind: c.kind, title: text(c.title, 500), summary: text(c.text, 300) }] : [];
    }),
  };
}

export interface ValidityDeps {
  /** The one call of the `ticket_validity` decision pack on the flattened context. */
  decide(context: TicketContext): Promise<ValidityAnswer>;
}

/** One call. Null when it fails: the ticket is not assessed and nothing is said about it. */
export async function checkValidity(deps: ValidityDeps, ticket: CanonicalTicket, enrichment: TicketEnrichment, candidates: Array<{ id: string; kind: "open" | "closed" | "backlog"; title: string; text: string }>): Promise<TicketValidity | null> {
  try {
    return validityOf(await deps.decide(buildValidityContext(ticket, enrichment, candidates)), enrichment.shortlist);
  } catch (error) {
    console.warn(`ticket validity: the decision failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}
