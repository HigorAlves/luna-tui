// The ticket safety screen's port: one call of the `ticket_safety` pack over a ticket, then the outcome by script (RFC 0012). It never throws: a screen
// that could not answer is `suspicious` with `screen_failed`, so a ticket is held, never waved through. The pre-pass runs on the RAW text, before `safe()`.
import { PACKS, SAFETY_REASONS, type CanonicalTicket, type SafetyReason, type TicketContext } from "@hardness/contracts";

import { safe } from "../domain/evidence-markdown.ts";
import { type RawTicket, type SafetyAnswer, SCREENED_TEXT_LIMIT, SCREEN_CHUNK, SCREEN_OVERLAP, contentHash, screenedComments, prepass, screenFailed, screenOutcome, signalsOf } from "../domain/ticket-screen.ts";
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
export const rawOf = (ticket: CanonicalTicket): RawTicket => ({ title: ticket.title, description: ticket.description, comments: ticket.comments.map((c) => c.text), ...(ticket.textHash ? { full: ticket.textHash } : {}) });

/**
 * Text that is not a tracker's ticket (a Slack message, the ticket of a `POST /runs`) in the shape the screen reads. Only the words are read: the `tool` is a placeholder and carries no meaning.
 */
export function ticketOfText(text: { key: string; title: string; description: string; comments?: Array<{ author: string; text: string }> }): CanonicalTicket {
  return {
    tool: "github", id: text.key, key: text.key, title: text.title, description: text.description, type: null, status: null, priority: null, reporter: null, assignee: null, labels: [], components: [],
    links: { blocks: [], duplicates: [], epic: null }, comments: (text.comments ?? []).map((c) => ({ author: c.author, text: c.text, at: null })), attachments: [], sprint: null, dueAt: null, createdAt: null, updatedAt: null, permalink: "",
  };
}

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

/** Pieces of at most `size` characters that overlap by `overlap`, so an instruction cut by a boundary is whole in one of them. Empty text has no piece. */
const pieces = (text: string, size: number, overlap: number): string[] => {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size - overlap) {
    out.push(text.slice(i, i + size));
    if (i + size >= text.length) break;
  }
  return out;
};

/** One part of a ticket: the description piece and the comment pieces one call reads. */
type Chunk = { description: string; comments: Array<{ author: string; text: string }> };

/**
 * The ticket as the parts the pack reads: its flattened description (at most `SCREENED_TEXT_LIMIT` raw characters) in pieces of at most `SCREEN_CHUNK` (overlapping by `SCREEN_OVERLAP`), then every comment (at most that many raw
 * characters in all) in pieces of at most 500, packed into the parts so no part holds more than `SCREEN_CHUNK` characters or ten comments. The last description piece shares its part with the
 * first comments, so a short ticket is one call. Text is flattened before it is cut: `safe()` makes some characters longer, and a cut after it would drop text unread.
 */
function chunksOf(ticket: CanonicalTicket): Chunk[] {
  const parts = pieces(safe(ticket.description.slice(0, SCREENED_TEXT_LIMIT)), SCREEN_CHUNK, SCREEN_OVERLAP);
  const chunks: Chunk[] = parts.slice(0, -1).map((description) => ({ description, comments: [] }));
  let cur: Chunk = { description: parts[parts.length - 1] ?? "", comments: [] };
  let used = cur.description.length;
  const texts = screenedComments(ticket.comments.map((c) => c.text));
  for (const [i, text] of texts.entries()) {
    const author = safe(ticket.comments[i]!.author).slice(0, 120);
    for (const piece of pieces(safe(text), 500, 100)) {
      if (used + piece.length > SCREEN_CHUNK || cur.comments.length >= 10) {
        chunks.push(cur);
        cur = { description: "", comments: [] };
        used = 0;
      }
      cur.comments.push({ author, text: piece });
      used += piece.length;
    }
  }
  chunks.push(cur);
  return chunks;
}

/** How many chunk calls run at once. */
const PARALLEL = 4;

export function createTicketScreen(deps: { decide(context: TicketContext, repoPath: string | null): Promise<{ answer: unknown; recordId?: string } | null> }): TicketScreen {
  return {
    async screen(ticket, repoPath) {
      const raw = rawOf(ticket);
      const hash = contentHash(raw);
      try {
        const found = prepass(raw);
        const signals = signalsOf(found);
        const chunks = chunksOf(ticket);
        const results: Array<{ verdict: "safe" | "suspicious" | "unsafe"; reasons: SafetyReason[]; recordId?: string } | null> = new Array(chunks.length).fill(null);
        // Every part is read; a part that cannot be answered fails the whole screen (a part nobody read could hold anything).
        let next = 0;
        const worker = async () => {
          while (next < chunks.length) {
            const i = next++;
            const chunk = chunks[i]!;
            const part: CanonicalTicket = { ...ticket, description: chunk.description, comments: chunk.comments.map((c) => ({ author: c.author, text: c.text, at: null })) };
            const context: TicketContext = { ...buildValidityContext(part, empty, []), signals, chunk: { index: i + 1, of: chunks.length } };
            const out = await deps.decide(context, repoPath);
            const answer = out ? answerOf(out.answer) : null;
            if (!out || !answer) return;
            results[i] = { ...screenOutcome(answer, found), ...(out.recordId ? { recordId: out.recordId } : {}) };
          }
        };
        await Promise.all(Array.from({ length: Math.min(PARALLEL, chunks.length) }, worker));
        // A failed part stops its worker, so check every slot rather than the count of calls.
        if (results.some((r) => r === null)) return { ...screenFailed(), hash };
        const done = results as NonNullable<(typeof results)[number]>[];
        const rank = { safe: 0, suspicious: 1, unsafe: 2 } as const;
        const worst = done.reduce((a, b) => (rank[b.verdict] > rank[a.verdict] ? b : a));
        const reasons = SAFETY_REASONS.filter((r) => done.some((d) => d.reasons.includes(r)));
        return { verdict: worst.verdict, reasons, hash, ...(worst.recordId ? { recordId: worst.recordId } : {}) };
      } catch (error) {
        console.warn(`ticket safety: the screen failed: ${error instanceof Error ? error.message : String(error)}`);
        return { ...screenFailed(), hash };
      }
    },
  };
}
