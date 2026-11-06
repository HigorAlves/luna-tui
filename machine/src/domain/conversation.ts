// The conversation machine's pure part: a raw chat message becomes the canonical one.
import { type CanonicalMessage, type ChannelKind, type Conversation, MESSAGE_CAPS } from "@hardness/contracts";

import type { RawMessage } from "../application/slack.ts";
import { screen } from "./secrets-check.ts";

export interface MessageContext {
  channel: { id: string; name: string; kind: ChannelKind };
  author: { id: string; name: string; isBot: boolean };
  permalink: string;
  /** The text as the inbox already made it plain (mentions named); mentions are still read from the raw text. */
  text?: string;
}

const slackTsToIso = (ts: string): string => new Date(Number(ts) * 1000).toISOString();

/** The canonical message of a raw one: text screened and capped, mentions as user ids, files as references. */
export function canonicalMessageOf(raw: RawMessage, ctx: MessageContext): CanonicalMessage {
  const mentions = [...new Set([...raw.text.matchAll(/<@([A-Z0-9]+)>/g)].map((m) => m[1]!))].slice(0, MESSAGE_CAPS.mentions);
  return {
    id: `${ctx.channel.id}:${raw.ts}`,
    threadId: `${ctx.channel.id}:${raw.threadTs ?? raw.ts}`,
    platform: "slack",
    channel: ctx.channel,
    author: ctx.author,
    text: screen(ctx.text ?? raw.text).text.slice(0, MESSAGE_CAPS.text),
    attachments: (raw.files ?? []).slice(0, MESSAGE_CAPS.attachments).map((f) => ({ id: f.id, name: f.name, kind: f.kind })),
    mentions,
    permalink: ctx.permalink,
    ts: raw.ts,
    editedAt: raw.editedTs ? slackTsToIso(raw.editedTs) : null,
    deleted: false,
  };
}

// ---------------------------------------------------------------------------------------------
// The conversation object: one per thread. Pure folds over it.


import type { Screened } from "./secrets-check.ts";

const byTs = (a: string, b: string): number => Number(a) - Number(b);

/** A conversation with nothing in it yet, for a channel of this kind. */
export function emptyConversation(channel: { kind: ChannelKind }, repo: string | null = null): Conversation {
  return { history: [], participants: [], private: channel.kind !== "channel", repo, classification: null, relation: null, redactions: 0, pii: [] };
}

/**
 * One more message in the thread. Idempotent by message id (a message already held is left as it is: an edit goes
 * through `applyEdit`); the history stays in ts order and keeps the last `MESSAGE_CAPS.history`.
 * `screened` is what `screen()` said of the raw text: its counts are added once, when the message is new.
 */
export function foldMessage(conversation: Conversation, message: CanonicalMessage, screened?: Pick<Screened, "secrets" | "pii">): Conversation {
  if (conversation.history.some((m) => m.id === message.id)) return conversation;
  const history = [...conversation.history, message].sort((a, b) => byTs(a.ts, b.ts)).slice(-MESSAGE_CAPS.history);
  const participants = conversation.participants.some((p) => p.id === message.author.id) ? conversation.participants : [...conversation.participants, message.author].slice(0, MESSAGE_CAPS.participants);
  const pii = screened ? [...new Set([...conversation.pii, ...screened.pii])].sort() : conversation.pii;
  return { ...conversation, history, participants, redactions: conversation.redactions + (screened?.secrets ?? 0), pii };
}

export interface MessageEdit {
  /** The message's canonical id. */
  id: string;
  /** The new, already screened text; ignored when `deleted`. */
  text?: string;
  /** ISO. */
  editedAt: string;
  deleted?: boolean;
}

/** An edit or a deletion applied to the message it names; a message the history does not hold leaves the conversation as it was. */
export function applyEdit(conversation: Conversation, edit: MessageEdit): Conversation {
  const at = conversation.history.findIndex((m) => m.id === edit.id);
  if (at === -1) return conversation;
  const held = conversation.history[at]!;
  const next: CanonicalMessage = edit.deleted ? { ...held, text: "", attachments: [], deleted: true, editedAt: edit.editedAt } : { ...held, text: (edit.text ?? held.text).slice(0, MESSAGE_CAPS.text), editedAt: edit.editedAt };
  return { ...conversation, history: conversation.history.map((m, i) => (i === at ? next : m)) };
}

/** The text of the thread's latest message that is still there; "" when every one was deleted. */
export const latestText = (conversation: Conversation): string => [...conversation.history].reverse().find((m) => !m.deleted)?.text ?? "";
