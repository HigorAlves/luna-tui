// Enrichment of a ticket before it is judged, by script and existing ports: its linked tickets and epic, the same reporter's and
// component's recent tickets, the code its text points at (`Graph.locate`) and the cards and backlog items it may duplicate. Every
// read is bounded and a port that fails is an empty answer: enrichment never holds a ticket up. Nothing a ticket names (an attachment, an
// address, a path) is ever opened: the text only goes to `locate` as words to match.
import type { CanonicalTicket } from "@hardness/contracts";

import { type Candidate, type Near, similar } from "../domain/similarity.ts";

export const ENRICH_CAPS = { linked: 20, recent: 10, files: 10 } as const;

export interface EnrichDeps {
  /** Which code the text points at (Graph.locate over the repository); absent when the repository has no graph. */
  locate?(text: string): Promise<string[]>;
  /** The same reporter's and component's recent tickets, newest first. */
  recent?(ticket: CanonicalTicket): Promise<Array<{ key: string; title: string }>>;
  /** The cards and backlog items this ticket's audience may see (wave 14's `canSeeKept` has already filtered them). */
  candidates: Candidate[];
  /** Wave 14's lookback, in days. */
  lookbackDays?: number;
}

export interface TicketEnrichment {
  linked: string[];
  epic: string | null;
  recent: Array<{ key: string; title: string }>;
  files: string[];
  shortlist: Near[];
}

async function bounded<T>(run: (() => Promise<T[]>) | undefined, max: number): Promise<T[]> {
  if (!run) return [];
  try {
    return (await run()).slice(0, max);
  } catch {
    return [];
  }
}

export async function enrichTicket(ticket: CanonicalTicket, deps: EnrichDeps, now: Date): Promise<TicketEnrichment> {
  const text = `${ticket.title}\n${ticket.description}`;
  const [files, recent] = await Promise.all([bounded(deps.locate ? () => deps.locate!(text) : undefined, ENRICH_CAPS.files), bounded(deps.recent ? () => deps.recent!(ticket) : undefined, ENRICH_CAPS.recent)]);
  return {
    linked: [...ticket.links.blocks, ...ticket.links.duplicates].slice(0, ENRICH_CAPS.linked),
    epic: ticket.links.epic,
    recent: recent.filter((r) => r.key !== ticket.key),
    files,
    shortlist: similar({ title: ticket.title, text: ticket.description, repo: null }, deps.candidates, { now, lookbackDays: deps.lookbackDays ?? 90 }),
  };
}
