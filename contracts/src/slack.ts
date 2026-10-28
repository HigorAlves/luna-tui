// The Slack inbox: everything your Activity tab shows, plus the handles you watch, as the
// machine polls it, triages it and the board shows it. The machine classifies; the board
// only reads `split` and `triage`.
import { z } from "zod";

import type { Stats } from "./api.ts";

/** Where an item sits for you. One split per item, picked by the machine's `splitOf`. */
export const SlackSplit = z.enum(["needs_reply", "waiting_on_them", "decide", "fyi", "snoozed", "done"]);
export type SlackSplit = z.infer<typeof SlackSplit>;

export const SlackPriority = z.enum(["P0", "P1", "P2", "P3"]);
export type SlackPriority = z.infer<typeof SlackPriority>;

export const SlackCategory = z.enum(["blocker", "decision", "question", "request", "fyi", "social", "automated"]);
export type SlackCategory = z.infer<typeof SlackCategory>;

/** How an item reached your inbox. `watch` is a watched handle, keyword or channel. */
export const SlackItemKind = z.enum(["mention", "dm", "thread_reply", "reaction", "watch", "automated"]);
export type SlackItemKind = z.infer<typeof SlackItemKind>;

/** What a watch listens for. */
export const SlackWatchKind = z.enum(["usergroup", "broadcast", "keyword", "channel"]);
export type SlackWatchKind = z.infer<typeof SlackWatchKind>;

/** A handle, broadcast, keyword or channel the inbox treats as addressed to you. */
export interface SlackWatch {
  id: string;
  kind: SlackWatchKind;
  /** The usergroup id (`S…`), the broadcast (`here` | `channel` | `everyone`), the keyword, or the channel id. */
  value: string;
  /** What the board shows: `@platform-team`, `@here`, the keyword, `#channel`. */
  label: string;
  /** Channel ids a keyword is limited to; empty means everywhere. */
  channels: string[];
  enabled: boolean;
  /** The three broadcasts ship on and cannot be deleted, only switched off. */
  builtin: boolean;
  /** A floor for triage: an item matching this watch is at least this priority. */
  priority: SlackPriority | null;
  createdAt: string;
}

export const SlackWatchInput = z.object({
  kind: SlackWatchKind,
  value: z.string().min(1),
  label: z.string().min(1).optional(),
  channels: z.array(z.string()).default([]),
  priority: SlackPriority.nullable().default(null),
});
export type SlackWatchInput = z.infer<typeof SlackWatchInput>;

export const SlackWatchPatch = z.object({
  label: z.string().min(1).optional(),
  channels: z.array(z.string()).optional(),
  priority: SlackPriority.nullable().optional(),
  enabled: z.boolean().optional(),
});
export type SlackWatchPatch = z.infer<typeof SlackWatchPatch>;

/** What Haiku (or a rule) decided about an item. */
export interface SlackTriage {
  priority: SlackPriority;
  category: SlackCategory;
  /** The text asks you for something nobody has answered yet. */
  expectsReply: boolean;
  /** One line for the row: what they want from you, not what they said. */
  summary: string;
  why: string;
  /** A reply to edit and send, only when `expectsReply`. */
  draft: string | null;
  refs: { kind: "pr" | "issue" | "jira" | "url"; ref: string }[];
  /** A date the text names, ISO; null otherwise. */
  deadline: string | null;
  /** `rules` when the pre-pass settled it without the model. */
  by: "model" | "rules";
  triagedAt: string;
  /** You changed the priority by hand; re-triage keeps your value. */
  overridden: boolean;
}

export interface SlackUser {
  id: string;
  name: string;
  isBot: boolean;
}

/** One earlier message, for the model and the pane. */
export interface SlackMessage {
  ts: string;
  user: SlackUser;
  text: string;
}

/** One thing in your inbox: a message, or a thread's worth of them collapsed into one. */
export interface SlackItem {
  /** `<channel id>:<message ts>`; for a collapsed thread, the parent's. */
  id: string;
  kind: SlackItemKind;
  channel: { id: string; name: string; kind: "channel" | "group" | "dm" | "mpim" };
  author: SlackUser;
  /** The latest message's text, mrkdwn turned into plain text. */
  text: string;
  /** The parent's ts when the item is inside a thread. */
  threadTs: string | null;
  /** Up to three earlier messages of the thread or DM, oldest first. */
  context: SlackMessage[];
  permalink: string;
  /** The latest message's time, ISO. */
  ts: string;
  /** Why it is in your inbox: `me`, `usergroup:S…`, `broadcast:here`, `keyword:…`, `channel:C…`, `dm`, `thread`, `reaction`. */
  matched: string[];
  /** Messages collapsed into this item. */
  count: number;
  /** Replies in the thread since the item's first message. */
  replies: number;
  /** You posted in the thread after the latest message addressed to you. */
  youReplied: boolean;
  seenAt: string | null;
  doneAt: string | null;
  snoozedUntil: string | null;
  /** The thread moved after you cleared it; the pane says "new since you cleared it". */
  reopenedAt: string | null;
  triage: SlackTriage | null;
  split: SlackSplit;
  linked: { pr: { repo: string; number: number; split: string } | null; taskId: string | null };
}

/** `GET /slack/items` and the `slack.items` stream event. */
export interface SlackSnapshot {
  items: SlackItem[];
  watches: SlackWatch[];
  me: SlackUser | null;
  polledAt: string | null;
  error: string | null;
  /** The Socket Mode websocket: `off` without an app token. */
  socket: "connected" | "disconnected" | "off";
}

export const SlackItemPatch = z.object({
  /** true clears the item (our side only unless the machine is told to mark Slack too); false reopens it. */
  done: z.boolean().optional(),
  /** ISO until when; null un-snoozes. */
  snoozedUntil: z.string().nullable().optional(),
  seen: z.boolean().optional(),
  /** A hand override of triage's priority. */
  priority: SlackPriority.optional(),
});
export type SlackItemPatch = z.infer<typeof SlackItemPatch>;

export const SlackReplyInput = z.object({ text: z.string().min(1) });
export type SlackReplyInput = z.infer<typeof SlackReplyInput>;

/** `POST /slack/items/:id/task`: a Backlog ticket from the item. */
export const SlackTaskInput = z.object({
  title: z.string().min(1).optional(),
  repoPath: z.string().nullable().optional(),
});
export type SlackTaskInput = z.infer<typeof SlackTaskInput>;

/** `GET /slack/metrics?since=7d|30d`: how fast you answer. */
export interface SlackMetrics {
  since: string;
  /** Items that arrived in the window, by priority. */
  items: Record<SlackPriority, number>;
  /** Items that expected a reply and got one from you, by priority. */
  replied: Record<SlackPriority, number>;
  /** Of those replied, how many within an hour. */
  withinHour: number;
  /** Seconds from the message to your reply, by priority. */
  timeToReply: Record<SlackPriority, Stats>;
  byDay: { day: string; items: number; replied: number }[];
}
