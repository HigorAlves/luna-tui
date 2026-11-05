// The tickets port over the GitHub port: issues carrying a label, in one repository. Keys read `owner/repo#number`.
import type { CanonicalTicket } from "@hardness/contracts";

import { GitHubError, type GitHub } from "../../application/github.ts";
import type { TicketFilter, Tickets } from "../../application/tickets.ts";
import { canonicalTicketOf } from "../../domain/ticket.ts";

const KEY = /^([\w.-]+\/[\w.-]+)#(\d+)$/;

function parse(key: string): { slug: string; number: number } {
  const m = KEY.exec(key);
  if (!m) throw new GitHubError(`not a GitHub issue key: ${key.slice(0, 80)}`);
  return { slug: m[1]!, number: Number(m[2]) };
}

export class GitHubTickets implements Tickets {
  constructor(private readonly github: GitHub) {}

  async listInScope(filter: TicketFilter): Promise<CanonicalTicket[]> {
    if (!filter.slug || !filter.label) return [];
    const issues = await this.github.listReadyIssues(filter.slug, filter.label);
    return issues.map((issue) => canonicalTicketOf({ tool: "github", slug: filter.slug!, issue }));
  }

  async read(key: string): Promise<CanonicalTicket> {
    parse(key);
    throw new GitHubError("the GitHub port reads issues only by label for now: list the repository instead");
  }

  async comment(key: string, text: string): Promise<void> {
    const { slug, number } = parse(key);
    await this.github.commentOnIssue(slug, number, text);
  }

  async transition(key: string): Promise<void> {
    parse(key);
    throw new GitHubError("a GitHub issue has no transitions the machine makes");
  }

  async link(key: string, url: string): Promise<void> {
    const { slug, number } = parse(key);
    await this.github.commentOnIssue(slug, number, `Linked: ${url}`);
  }
}
