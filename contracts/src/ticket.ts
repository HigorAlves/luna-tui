// The canonical ticket of the v2.2 Ticket Machine: one shape for a Jira issue and a GitHub issue, so everything after the read
// (scope, validity, assessment, drafts) never asks which tool a ticket came from. Its text is written by strangers: every
// text is capped and every list bounded here, and the machine flattens it before it is built.
import { z } from "zod";

/** The most each text may hold and each list may carry. */
export const TICKET_CAPS = {
  title: 300,
  description: 8000,
  commentText: 2000,
  comments: 30,
  labels: 30,
  components: 20,
  links: 30,
  attachments: 20,
  name: 120,
} as const;

const name = z.string().max(TICKET_CAPS.name);
const person = z.object({ id: name, name: name.optional() });

export const TicketTool = z.enum(["jira", "github"]);
export type TicketTool = z.infer<typeof TicketTool>;

export const CanonicalTicket = z.object({
  tool: TicketTool,
  /** The tool's own id: the Jira key, or `owner/repo#number`. */
  id: z.string().max(200),
  /** What a person calls it; the same as `id` today. */
  key: z.string().max(200),
  title: z.string().max(TICKET_CAPS.title),
  description: z.string().max(TICKET_CAPS.description),
  type: name.nullable(),
  /** The tool's status, in the tool's words. */
  status: name.nullable(),
  /** The tool's priority, in the tool's words. */
  priority: name.nullable(),
  reporter: person.nullable(),
  assignee: name.nullable(),
  labels: z.array(name).max(TICKET_CAPS.labels),
  components: z.array(name).max(TICKET_CAPS.components),
  links: z.object({
    blocks: z.array(z.string().max(200)).max(TICKET_CAPS.links),
    duplicates: z.array(z.string().max(200)).max(TICKET_CAPS.links),
    epic: z.string().max(200).nullable(),
  }),
  comments: z.array(z.object({ author: name, text: z.string().max(TICKET_CAPS.commentText), at: z.string().max(60).nullable() })).max(TICKET_CAPS.comments),
  /** References only: a name and where the tool keeps it. Never opened by the machine. */
  attachments: z.array(z.object({ name: name, url: z.string().max(500) })).max(TICKET_CAPS.attachments),
  sprint: name.nullable(),
  dueAt: z.string().max(60).nullable(),
  createdAt: z.string().max(60).nullable(),
  updatedAt: z.string().max(60).nullable(),
  permalink: z.string().max(500),
});
export type CanonicalTicket = z.infer<typeof CanonicalTicket>;

/** The taps of the Ticket Machine: what a person sends with a draft they read. `hash` is the draft's hash as `GET /tickets` showed it. */
export const TicketApproveInput = z.object({ draft: z.string().min(1).max(300), hash: z.string().min(1).max(64), transition: z.string().min(1).max(100).optional() }).strict();
export type TicketApproveInput = z.infer<typeof TicketApproveInput>;
export const TicketEditInput = TicketApproveInput.extend({ text: z.string().min(1).max(1500) }).strict();
export type TicketEditInput = z.infer<typeof TicketEditInput>;
export const TicketIgnoreInput = z.object({ draft: z.string().min(1).max(300) }).strict();
export type TicketIgnoreInput = z.infer<typeof TicketIgnoreInput>;
