// The conversation machine's canonical message: one shape for a chat message whatever the platform, built by
// `canonicalMessageOf` (machine/src/domain/conversation.ts) from the port's raw message. Text is already screened
// and capped; an attachment is a reference (an id, a name, a kind) and never content or an address the machine opens.
import { z } from "zod";

/** Bounds on every text and list a conversation holds. */
export const MESSAGE_CAPS = { text: 4000, attachments: 10, mentions: 20, history: 20, participants: 30 } as const;

export const ChannelKind = z.enum(["channel", "group", "dm", "mpim"]);
export type ChannelKind = z.infer<typeof ChannelKind>;

export const CanonicalAttachment = z.object({ id: z.string(), name: z.string(), kind: z.string() });
export type CanonicalAttachment = z.infer<typeof CanonicalAttachment>;

export const CanonicalMessage = z.object({
  /** `<channel>:<ts>` */
  id: z.string(),
  /** `<channel>:<root ts>`: the id a `SlackItem` already has. */
  threadId: z.string(),
  platform: z.literal("slack"),
  channel: z.object({ id: z.string(), name: z.string(), kind: ChannelKind }),
  author: z.object({ id: z.string(), name: z.string(), isBot: z.boolean() }),
  text: z.string().max(MESSAGE_CAPS.text),
  attachments: z.array(CanonicalAttachment).max(MESSAGE_CAPS.attachments),
  /** User ids. */
  mentions: z.array(z.string()).max(MESSAGE_CAPS.mentions),
  permalink: z.string(),
  /** The platform's own message time (a Slack ts). */
  ts: z.string(),
  /** ISO time of the latest edit; null when never edited. */
  editedAt: z.string().nullable(),
  deleted: z.boolean(),
});
export type CanonicalMessage = z.infer<typeof CanonicalMessage>;

/** What a thread is about, relative to existing work (slice 6 fills it). */
export const ConversationRelationType = z.enum(["related_to_in_progress", "related_to_backlog", "new_candidate", "none", "ask"]);
export type ConversationRelationType = z.infer<typeof ConversationRelationType>;

/** What kind of thing a thread is: the first question of `conversation_assess`. */
export const ConversationKind = z.enum(["incident", "bug", "request", "question", "fyi", "chatter"]);
export type ConversationKind = z.infer<typeof ConversationKind>;

export interface ConversationClassification {
  /** incident, bug, request, question, fyi or chatter; set by the typed decision or by hand. */
  kind: string;
  confidence: number;
  by: "model" | "person";
  /** ISO time of the answer: the board hears a change through it. */
  at: string;
  /** Decision record ids by step. */
  records: Record<string, string>;
  /** `ask`: the machine was not sure of the kind or of the need for a reply and waits for a person. Absent on a hand-set kind. */
  verdict?: "ok" | "ask";
  /** What the machine computed, kept for the board and the ground truth: its level, total, the flag that hit and each sub-score (1 to 3). */
  priority?: string;
  total?: number;
  knockOut?: string | null;
  scores?: Record<string, { score: number; confidence: number }>;
}

export interface ConversationRelation {
  type: ConversationRelationType;
  target: string | null;
  confidence: number;
  by: "model" | "person";
  at: string;
  record?: string;
  /** Where a ticket-sourced card came from (a channel a repository claims sees such cards): the board says so on its own line before the tap. */
  otherSource?: { kind: "jira" | "github"; key: string } | null;
}

/** The ids behind the slots the relation decision saw: a target a person sets must be one of them, never anything a message names. */
export interface ConversationShortlistEntry {
  slot: number;
  id: string;
  kind: "open" | "closed" | "backlog";
  otherSource: { kind: "jira" | "github"; key: string } | null;
}

export interface ConversationParticipant {
  id: string;
  name: string;
  isBot: boolean;
}

/** One thread as the machine holds it: its recent messages, its people and what it decided about them. Optional on a `SlackItem`: null on rows from before wave 17. */
export interface Conversation {
  /** The last `MESSAGE_CAPS.history` messages, oldest first. */
  history: CanonicalMessage[];
  participants: ConversationParticipant[];
  /** A private channel, a DM or a group DM: its text never leaves for another thread, a card or a backlog item. */
  private: boolean;
  /** The one repository whose `luna.yaml` claims the channel; null otherwise. */
  repo: string | null;
  classification: ConversationClassification | null;
  relation: ConversationRelation | null;
  /** What the last assessment offered as targets; absent before wave 17's relation. */
  shortlist?: ConversationShortlistEntry[];
  /** How many secrets were cut from this thread's messages. */
  redactions: number;
  /** Which personal data the stored text still holds. */
  pii: Array<"email" | "phone">;
}
