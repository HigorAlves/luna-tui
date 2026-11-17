// The ticket safety screen's port: one call of the `ticket_safety` pack over a ticket, then the outcome by script (RFC 0012). It never throws: a screen
// that could not answer is `suspicious` with `screen_failed`, so a ticket is held, never waved through. The pre-pass runs on the RAW text, before `safe()`.
import { PACKS, type CanonicalTicket, type SafetyReason, type TicketContext } from "@hardness/contracts";

import { type RawTicket, type SafetyAnswer, contentHash, prepass, screenFailed, screenOutcome, signalsOf } from "../domain/ticket-screen.ts";
import { buildValidityContext } from "./ticket-validity.ts";

export interface Screened {
  verdict: "safe" | "suspicious" | "unsafe";
  reasons: SafetyReason[];
  /** A hash of everything the screen read: an edited ticket has another one. */
  hash: string;
  /** The decision record behind the answer, when the call left one. */
  recordId?: string;
}

export interface TicketScreen {
  screen(ticket: CanonicalTicket, repoPath: string | null): Promise<Screened>;
}

/** What the screen reads of a ticket: its text as the tool sent it. */
export const rawOf = (ticket: CanonicalTicket): RawTicket => ({ title: ticket.title, description: ticket.description, comments: ticket.comments.map((c) => c.text) });

const empty = { linked: [], epic: null, recent: [], files: [], shortlist: [] };

/** An answer holds every question as a yes/no with a probability; anything else is no answer (a missing one would read as a no). */
function answerOf(raw: unknown): SafetyAnswer | null {
  if (raw === null || typeof raw !== "object") return null;
  const out: SafetyAnswer = {};
  for (const key of Object.keys(PACKS.ticket_safety.questions)) {
    const a = (raw as Record<string, unknown>)[key] as { value?: unknown; p?: unknown } | undefined;
    if (!a || typeof a.value !== "boolean" || typeof a.p !== "number" || Number.isNaN(a.p)) return null;
    out[key] = { value: a.value, p: a.p };
  }
  return out;
}

export function createTicketScreen(deps: { decide(context: TicketContext, repoPath: string | null): Promise<{ answer: unknown; recordId?: string } | null> }): TicketScreen {
  return {
    async screen(ticket, repoPath) {
      const raw = rawOf(ticket);
      const hash = contentHash(raw);
      try {
        const found = prepass(raw);
        const context: TicketContext = { ...buildValidityContext(ticket, empty, []), signals: signalsOf(found) };
        const out = await deps.decide(context, repoPath);
        const answer = out ? answerOf(out.answer) : null;
        if (!out || !answer) return { ...screenFailed(), hash };
        return { ...screenOutcome(answer, found), hash, ...(out.recordId ? { recordId: out.recordId } : {}) };
      } catch (error) {
        console.warn(`ticket safety: the screen failed: ${error instanceof Error ? error.message : String(error)}`);
        return { ...screenFailed(), hash };
      }
    },
  };
}
