// The tickets port over the Jira port.
import type { CanonicalTicket } from "@hardness/contracts";

import type { Jira } from "../../application/jira.ts";
import type { TicketFilter, Tickets } from "../../application/tickets.ts";
import { canonicalTicketOf } from "../../domain/ticket.ts";

/** The most issues one listing reads. */
export const TICKETS_PAGE = 50;

export class JiraTickets implements Tickets {
  constructor(private readonly jira: Jira) {}

  async listInScope(filter: TicketFilter): Promise<CanonicalTicket[]> {
    if (!filter.jql) return [];
    const page = await this.jira.search(filter.jql, { maxResults: TICKETS_PAGE });
    return page.issues.map((issue) => canonicalTicketOf({ tool: "jira", issue }));
  }

  async read(key: string): Promise<CanonicalTicket> {
    return canonicalTicketOf({ tool: "jira", issue: await this.jira.issue(key) });
  }

  comment(key: string, text: string): Promise<void> {
    return this.jira.comment(key, text);
  }

  async transition(key: string, to: string): Promise<void> {
    const wanted = to.trim().toLowerCase();
    const found = (await this.jira.transitions(key)).find((t) => t.name.toLowerCase() === wanted || t.to.name.toLowerCase() === wanted);
    if (!found) throw new Error(`${key} has no transition to ${to}`);
    await this.jira.transition(key, found.id);
  }

  link(key: string, url: string): Promise<void> {
    return this.jira.comment(key, `Linked: ${url}`);
  }
}
