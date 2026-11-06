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
