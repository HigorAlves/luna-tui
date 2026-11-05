// The canonical ticket, built from what a tool says: pure. A ticket's words are a stranger's, so every text is
// redacted of token-shaped strings and capped, the title is one line, and every list is bounded.
import { type CanonicalTicket, TICKET_CAPS } from "@hardness/contracts";

import type { GhIssue } from "../application/github.ts";
import type { JiraIssue } from "../application/jira.ts";
import { redact } from "./evidence-markdown.ts";

const cap = (text: string, max: number): string => {
  const clean = redact(text);
  return clean.length > max ? clean.slice(0, max) : clean;
};
const line = (text: string, max: number): string => cap(text.replace(/\s+/g, " ").trim(), max);
const word = (text: string | null | undefined): string | null => (text ? line(text, TICKET_CAPS.name) : null);
const words = (items: readonly string[], max: number): string[] => items.slice(0, max).map((i) => line(i, TICKET_CAPS.name));

export type TicketSource = { tool: "jira"; issue: JiraIssue } | { tool: "github"; slug: string; issue: GhIssue };

export function canonicalTicketOf(source: TicketSource): CanonicalTicket {
  if (source.tool === "jira") {
    const i = source.issue;
    return {
      tool: "jira",
      id: i.key,
      key: i.key,
      title: line(i.summary, TICKET_CAPS.title),
      description: cap(i.description, TICKET_CAPS.description),
      type: word(i.issueType),
      status: word(i.status),
      priority: word(i.priority),
      reporter: i.reporter ? { id: line(i.reporter.id, TICKET_CAPS.name), ...(i.reporter.name ? { name: line(i.reporter.name, TICKET_CAPS.name) } : {}) } : null,
      assignee: null,
      labels: words(i.labels, TICKET_CAPS.labels),
      components: [],
      links: { blocks: [], duplicates: [], epic: null },
      comments: i.comments.slice(0, TICKET_CAPS.comments).map((c) => ({ author: line(c.author, TICKET_CAPS.name), text: cap(c.text, TICKET_CAPS.commentText), at: c.created || null })),
      attachments: [],
      sprint: null,
      dueAt: i.dueAt,
      createdAt: null,
      updatedAt: i.updated,
      permalink: line(i.url, 500),
    };
  }
  const g = source.issue;
  const id = `${source.slug}#${g.number}`;
  return {
    tool: "github",
    id,
    key: id,
    title: line(g.title, TICKET_CAPS.title),
    description: cap(g.body ?? "", TICKET_CAPS.description),
    type: null,
    status: "open",
    priority: null,
    reporter: g.author ? { id: line(g.author, TICKET_CAPS.name), name: line(g.author, TICKET_CAPS.name) } : null,
    assignee: null,
    labels: words(g.labels ?? [], TICKET_CAPS.labels),
    components: [],
    links: { blocks: [], duplicates: [], epic: null },
    comments: [],
    attachments: [],
    sprint: null,
    dueAt: null,
    createdAt: null,
    updatedAt: null,
    permalink: line(g.url, 500),
  };
}
