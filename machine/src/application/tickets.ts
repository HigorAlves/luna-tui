// The tickets port: what the Ticket Machine asks a tracker, whatever the tracker. The Jira adapter and the GitHub issue adapter
// (machine/src/adapters/tickets/) implement it; tests pass a fake; `noTokenTickets()` is the fallback. The three writing calls
// (comment, transition, link) are made only on a person's tap: nothing in the machine calls them by itself while `tickets.auto` is off.
import type { CanonicalTicket } from "@hardness/contracts";

import { messageOf } from "./github.ts";

/** What to look at: a JQL for Jira, a repository and a label for GitHub. */
export interface TicketFilter {
  jql?: string;
  slug?: string;
  label?: string;
}

export interface Tickets {
  /** The tickets the filter finds, as canonical tickets; the caller narrows them to its scope. */
  listInScope(filter: TicketFilter): Promise<CanonicalTicket[]>;
  /** One ticket by its key. */
  read(key: string): Promise<CanonicalTicket>;
  /** Posts `text` as a comment. A write: only on a tap. */
  comment(key: string, text: string): Promise<void>;
  /** Moves the ticket to the status named `to`. A write: only on a tap. */
  transition(key: string, to: string): Promise<void>;
  /** Leaves a link to `url` on the ticket. A write: only on a tap. */
  link(key: string, url: string): Promise<void>;
  /**
   * Creates a child ticket of `origin` (a split's part): in the origin's own project (Jira) or repository (GitHub), never anywhere the child names. A write:
   * only on a tap, with a title and body the machine made postable.
   */
  create(origin: CanonicalTicket, child: { title: string; body: string }, options?: { labels?: string[] }): Promise<{ key: string; permalink: string }>;
}

export class NoTicketTokenError extends Error {
  constructor() {
    super("no token for the ticket tracker: set the Jira or GitHub credentials for the machine");
    this.name = "NoTicketTokenError";
  }
}

/** The port with nothing behind it: every call fails with the same clear reason. */
export function noTokenTickets(): Tickets {
  const refuse = () => Promise.reject(new NoTicketTokenError());
  return { listInScope: refuse, read: refuse, comment: refuse, transition: refuse, link: refuse, create: refuse };
}

/** The ticket object as stored: one per key. The tool owns `canonical`; the machine owns the rest. */
export interface TicketRow {
  key: string;
  canonical: CanonicalTicket;
  /** What each assessment said, oldest first, sub-scores kept. */
  assessments: Record<string, unknown>[];
  cardId: string | null;
  /** Replies waiting for a person. */
  drafts: Record<string, unknown>[];
  clocks: Record<string, unknown>;
  /** The machine's own status for the ticket, apart from the tool's. */
  machineStatus: string | null;
  /** The machine's own links (to cards, to other tickets), apart from the tool's. */
  machineLinks: Array<{ kind: string; target: string }>;
  createdAt: Date;
  updatedAt: Date;
}

export interface TicketStore {
  /** Stores what the tool says: creates the object, or refreshes only what the tool owns. */
  read(ticket: CanonicalTicket): Promise<TicketRow>;
  get(key: string): Promise<TicketRow | null>;
  list(): Promise<TicketRow[]>;
  setMachine(key: string, change: { status?: string | null; links?: Array<{ kind: string; target: string }>; cardId?: string | null }): Promise<void>;
  appendAssessment(key: string, entry: Record<string, unknown>): Promise<void>;
  setDrafts(key: string, drafts: Record<string, unknown>[]): Promise<void>;
  /** Changes the drafts under a row lock (see the Postgres store): a draft being posted is never lost to a read-modify-write. */
  updateDrafts(key: string, change: (drafts: Record<string, unknown>[]) => Record<string, unknown>[]): Promise<void>;
  setClocks(key: string, clocks: Record<string, unknown>): Promise<void>;
}

export { messageOf };
