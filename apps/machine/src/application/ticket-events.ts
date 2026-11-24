// Ticket events reach the card. For a ticket that has a card (the watch reads each linked issue), a change of scope (title or description), of
// priority, of assignee, or a new comment is a row on the card, re-assesses the ticket, and is raised to the card's current stage: before Build the
// card's gate is marked for another look; during or after Build the card gets a flag and a person decides. A reassignment out of scope drafts a
// hand-over note and stops assessing. Nothing is posted: this file calls no write of the Tickets port, and its event rows carry no text from the ticket.
import type { CanonicalTicket, FactoryConfig } from "@hardness/contracts";

import { inScope, scopeConfigured, settled } from "../domain/ticket-scope.ts";
import type { TicketIntake } from "./ticket-machine.ts";
import { type Draft, handoverDraft } from "./ticket-drafts.ts";
import type { TicketStore } from "./tickets.ts";

export type TicketChangeKind = "scope_edited" | "priority_changed" | "reassigned" | "new_comment";

const same = (a: string | null, b: string | null) => (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();

/** What changed between two reads. `postedTexts` are drafts a person posted: a comment that is one of them is not news. */
export function ticketChanges(prev: CanonicalTicket, next: CanonicalTicket, postedTexts: string[]): TicketChangeKind[] {
  const out: TicketChangeKind[] = [];
  if (prev.title !== next.title || prev.description !== next.description) out.push("scope_edited");
  if (!same(prev.priority, next.priority)) out.push("priority_changed");
  if (!same(prev.assignee, next.assignee)) out.push("reassigned");
  const posted = new Set(postedTexts.map((t) => t.trim()));
  // The tool keeps the newest comments only, so a new one is found by its time and author (by its text when the tool gives no time), never by the count.
  const idOf = (c: CanonicalTicket["comments"][number]) => `${c.at ?? ""}|${c.author}|${c.at ? "" : c.text}`;
  const seen = new Set(prev.comments.map(idOf));
  if (next.comments.some((c) => !seen.has(idOf(c)) && !posted.has(c.text.trim()))) out.push("new_comment");
  return out;
}

/** The card as the events need it. */
export interface EventCard {
  id: string;
  state: string;
  repoPath: string | null;
  worktreePath: string | null;
  branch: string | null;
}

const BEFORE_BUILD = new Set(["draft", "setup", "awaiting_setup", "triage", "awaiting_answers", "test_design", "awaiting_approval", "awaiting_test_check"]);

export interface TicketEventsDeps {
  store: TicketStore;
  machine: TicketIntake;
  pipeline: { record(id: string, kind: string, payload: Record<string, unknown>): Promise<void>; noteTicketChange(id: string, change: { fields: string[]; at: string }): Promise<void> };
  config(repoPath: string | null): Promise<FactoryConfig>;
  now?: () => Date;
}

/** The least time between two forced re-assessments of one ticket. */
export const REASSESS_GAP_MS = 10 * 60_000;

export class TicketEvents {
  private readonly now: () => Date;
  constructor(private readonly deps: TicketEventsDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** Whether a ticket may be assessed again now: the edits have settled and the gap since the last forced one has passed. */
  private async mayReassess(key: string, next: CanonicalTicket, debounceSeconds: number): Promise<boolean> {
    const row = await this.deps.store.get(key);
    const last = typeof row?.clocks.lastReassessedAt === "string" ? Date.parse(row.clocks.lastReassessedAt) : NaN;
    const gap = Math.max(REASSESS_GAP_MS, debounceSeconds * 1000);
    return settled(next.updatedAt, this.now(), debounceSeconds) && (Number.isNaN(last) || this.now().getTime() - last >= gap);
  }

  private async mark(key: string, patch: Record<string, unknown>): Promise<void> {
    const row = await this.deps.store.get(key);
    if (row) await this.deps.store.setClocks(key, { ...row.clocks, ...patch });
  }

  /** The watch's read of a linked ticket. Returns what changed. Never posts. */
  async handle(next: CanonicalTicket, card: EventCard): Promise<TicketChangeKind[]> {
    const { store, pipeline } = this.deps;
    const prev = await store.get(next.key);
    if (!prev) {
      await store.read(next);
      return [];
    }
    const posted = (prev.drafts as unknown as Draft[]).filter((d) => d.status === "posted").map((d) => d.text);
    const changes = ticketChanges(prev.canonical, next, posted);
    if (changes.length === 0) {
      // A re-assessment held back by the gap happens once it has passed, with the latest ticket.
      if (prev.clocks.reassessPending === true && (await this.mayReassess(next.key, next, (await this.deps.config(null)).tickets.debounce_seconds))) {
        await this.deps.machine.ingest(next, { repoPath: (prev.machineLinks.find((l) => l.kind === "repo")?.target ?? null), question: false, force: true } as never);
        await this.mark(next.key, { reassessPending: false, lastReassessedAt: this.now().toISOString() });
      }
      return [];
    }
    for (const kind of changes) await pipeline.record(card.id, `ticket.${kind}`, { key: next.key });

    const config = await this.deps.config(card.repoPath);
    const out = changes.includes("reassigned") && scopeConfigured(config.tickets) && !inScope(next, config.tickets);
    if (out) {
      await store.read(next);
      await store.updateDrafts(next.key, (current) => [...(current as unknown as Draft[]).filter((d) => d.kind !== "handover"), handoverDraft(next.key)] as unknown as Record<string, unknown>[]);
      await store.setMachine(next.key, { status: "handed_over" });
      await pipeline.record(card.id, "ticket.flag", { key: next.key, why: "reassigned_out_of_scope" });
      return changes;
    }
    if (await this.mayReassess(next.key, next, config.tickets.debounce_seconds)) {
      await this.deps.machine.ingest(next, { repoPath: card.repoPath, question: false, force: true } as never);
      await this.mark(next.key, { reassessPending: false, lastReassessedAt: this.now().toISOString() });
    } else {
      // Held back: the ticket is stored as it is now, and one re-assessment follows the gap.
      await store.read(next);
      await this.mark(next.key, { reassessPending: true });
    }
    const beforeBuild = BEFORE_BUILD.has(card.state);
    await pipeline.record(card.id, beforeBuild ? "ticket.gate_recheck" : "ticket.flag", { key: next.key, changes });
    const fields = [...(changes.includes("scope_edited") ? ["scope"] : []), ...(changes.includes("priority_changed") ? ["priority"] : [])];
    if (beforeBuild && fields.length > 0) await pipeline.noteTicketChange(card.id, { fields, at: new Date().toISOString() });
    if (changes.includes("new_comment") && card.state === "awaiting_answers") await pipeline.record(card.id, "ticket.answered", { key: next.key });
    return changes;
  }
}
