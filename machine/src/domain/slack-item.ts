// The Slack inbox's domain: which split an item sits in, which watches a message trips, and
// how messages fold into items (several mentions in one thread are one item; a thread that
// moves after you cleared it reopens). Pure functions over the contract shapes; the poller
// in application/slack-inbox.ts feeds them and persists what they return.
import type { SlackItem, SlackPriority, SlackSplit, SlackWatch } from "@hardness/contracts";

import type { SlaTargets } from "./slack-rules.ts";

/** An item as stored: the contract's shape minus what is computed at snapshot time (split, dueAt, overdue), plus what metrics need. */
export interface SlackItemRow extends Omit<SlackItem, "split" | "dueAt" | "overdue"> {
  /** Slack's own ts of the latest message folded into the item. */
  slackTs: string;
  /** When the machine first stored the item. */
  arrivedAt: string;
  /** When you replied from the board, if you did. */
  repliedAt: string | null;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** Nobody answered your ask for this long: the thread is waiting on them. */
export const WAITING_AFTER_MS = DAY_MS;
/** An FYI nobody touched for this long is done. */
export const FYI_DONE_AFTER_MS = 7 * DAY_MS;
/** Done items stay in the snapshot this long. */
export const KEEP_DONE_MS = 30 * DAY_MS;

export const PRIORITY_RANK: Record<SlackPriority, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

/** The more urgent of two priorities; null stands for "no opinion". */
export function higher(a: SlackPriority | null, b: SlackPriority | null): SlackPriority | null {
  if (a === null) return b;
  if (b === null) return a;
  return PRIORITY_RANK[a] <= PRIORITY_RANK[b] ? a : b;
}

/** Where the item sits for you, from its triage and your state. */
export function splitOf(item: Pick<SlackItemRow, "doneAt" | "snoozedUntil" | "triage" | "youReplied" | "ts" | "kind">, now: Date): SlackSplit {
  if (item.doneAt) return "done";
  if (item.snoozedUntil && new Date(item.snoozedUntil).getTime() > now.getTime()) return "snoozed";
  const age = now.getTime() - new Date(item.ts).getTime();
  if (item.triage?.expectsReply && !item.youReplied) return "needs_reply";
  if (item.youReplied && age >= WAITING_AFTER_MS) return "waiting_on_them";
  if (!item.youReplied && item.triage && (item.triage.category === "blocker" || item.triage.category === "decision")) return "decide";
  if (age >= FYI_DONE_AFTER_MS) return "done";
  return "fyi";
}

/** `<@U123>` or `<@U123|name>` addressed to `userId`. */
export function mentionsUser(text: string, userId: string): boolean {
  return new RegExp(`<@${userId}(\\|[^>]*)?>`).test(text);
}

const BROADCASTS = ["here", "channel", "everyone"] as const;

/**
 * The keys of every enabled watch the raw mrkdwn trips: `usergroup:S…`, `broadcast:here`,
 * `keyword:<word>`, `channel:C…`. A keyword limited to channels matches only there.
 */
export function matchWatches(text: string, channelId: string, watches: SlackWatch[]): string[] {
  const keys: string[] = [];
  for (const watch of watches) {
    if (!watch.enabled) continue;
    switch (watch.kind) {
      case "usergroup":
        if (text.includes(`<!subteam^${watch.value}`)) keys.push(`usergroup:${watch.value}`);
        break;
      case "broadcast":
        if ((BROADCASTS as readonly string[]).includes(watch.value) && new RegExp(`<!${watch.value}(\\|[^>]*)?>`).test(text)) {
          keys.push(`broadcast:${watch.value}`);
        }
        break;
      case "keyword":
        if (watch.channels.length > 0 && !watch.channels.includes(channelId)) break;
        if (text.toLowerCase().includes(watch.value.toLowerCase())) keys.push(`keyword:${watch.value}`);
        break;
      case "channel":
        if (watch.value === channelId) keys.push(`channel:${watch.value}`);
        break;
    }
  }
  return keys;
}

/** The priority floor the matched watches set, if any. */
export function watchFloor(matched: string[], watches: SlackWatch[]): SlackPriority | null {
  let floor: SlackPriority | null = null;
  for (const watch of watches) {
    if (!watch.enabled || watch.priority === null) continue;
    const key = `${watch.kind}:${watch.value}`;
    if (matched.includes(key)) floor = higher(floor, watch.priority);
  }
  return floor;
}

/** A message the poller found addressed to you, before it is folded into an item. */
export interface IncomingMessage {
  id: string;
  kind: SlackItem["kind"];
  channel: SlackItem["channel"];
  author: SlackItem["author"];
  text: string;
  threadTs: string | null;
  context: SlackItem["context"];
  permalink: string;
  /** ISO. */
  ts: string;
  slackTs: string;
  matched: string[];
}

/** What folding a message in changed: whether triage must run again. */
export interface Folded {
  item: SlackItemRow;
  retriage: boolean;
}

/** The ts Slack gives (`1730112345.000100`) as a Date. */
export const slackTsToDate = (ts: string): Date => new Date(Math.round(Number(ts) * 1000));
export const compareTs = (a: string, b: string): number => Number(a) - Number(b);

/**
 * A new message addressed to you: a new item, or one more message folded into the thread's
 * item (`count` up, the latest text wins, `matched` merged). A cleared item reopens.
 */
export function fold(existing: SlackItemRow | null, incoming: IncomingMessage, now: Date): Folded {
  const at = now.toISOString();
  if (!existing) {
    return {
      retriage: true,
      item: {
        ...incoming,
        count: 1,
        replies: 0,
        youReplied: false,
        seenAt: null,
        doneAt: null,
        snoozedUntil: null,
        reopenedAt: null,
        triage: null,
        linked: { pr: null, taskId: null },
        arrivedAt: at,
        repliedAt: null,
      },
    };
  }
  if (compareTs(incoming.slackTs, existing.slackTs) <= 0) {
    // Seen before (or older than what we hold): only the match reasons may be new.
    const matched = union(existing.matched, incoming.matched);
    return { item: { ...existing, matched }, retriage: false };
  }
  const reopened = existing.doneAt !== null;
  return {
    retriage: true,
    item: {
      ...existing,
      text: incoming.text,
      author: incoming.author,
      ts: incoming.ts,
      slackTs: incoming.slackTs,
      context: incoming.context,
      permalink: incoming.permalink,
      matched: union(existing.matched, incoming.matched),
      count: existing.count + 1,
      youReplied: false,
      ...(reopened ? { doneAt: null, reopenedAt: at, snoozedUntil: null } : {}),
    },
  };
}

/** Something happened in the item's thread that is not a new ask: a reply, a reaction. */
export interface ThreadMovement {
  /** Replies in the thread since the item's first message. */
  replies: number;
  /** The latest reply is yours. */
  latestIsYours: boolean;
  /** Up to three messages before the latest, for the pane. */
  context?: SlackItem["context"];
}

/**
 * The thread moved: a cleared item reopens and is re-triaged (someone may have answered);
 * your own reply marks `youReplied`; a reply after yours clears it again.
 */
export function touch(existing: SlackItemRow, movement: ThreadMovement, now: Date): Folded {
  const moved = movement.replies !== existing.replies || movement.latestIsYours !== existing.youReplied;
  if (!moved) return { item: existing, retriage: false };
  const reopened = existing.doneAt !== null && !movement.latestIsYours;
  return {
    retriage: !movement.latestIsYours,
    item: {
      ...existing,
      replies: movement.replies,
      youReplied: movement.latestIsYours,
      ...(movement.context ? { context: movement.context } : {}),
      ...(reopened ? { doneAt: null, reopenedAt: now.toISOString(), snoozedUntil: null } : {}),
    },
  };
}

function union(a: string[], b: string[]): string[] {
  return [...new Set([...a, ...b])];
}

/**
 * When a reply is due and whether that passed: the latest message plus the SLA of the triage
 * priority (a hand override counts), only while the item still waits on you (a reply is
 * expected, you have not answered, it is not cleared, any snooze has passed). Computed at
 * snapshot time and never stored, so a changed SLA applies at once.
 */
export function dueOf(item: Pick<SlackItemRow, "ts" | "triage" | "youReplied" | "doneAt" | "snoozedUntil">, now: Date, sla: SlaTargets): Pick<SlackItem, "dueAt" | "overdue"> {
  const none = { dueAt: null, overdue: false };
  if (!item.triage?.expectsReply || item.youReplied || item.doneAt) return none;
  if (item.snoozedUntil && new Date(item.snoozedUntil).getTime() > now.getTime()) return none;
  const seconds = sla[item.triage.priority];
  if (seconds === null) return none;
  const due = new Date(item.ts).getTime() + seconds * 1000;
  return { dueAt: new Date(due).toISOString(), overdue: due < now.getTime() };
}

/** The item for the board: the row plus its split and its due time under `sla`. */
export function toSlackItem(row: SlackItemRow, now: Date, sla: SlaTargets): SlackItem {
  const { slackTs: _slackTs, arrivedAt: _arrivedAt, repliedAt: _repliedAt, ...item } = row;
  return { ...item, ...dueOf(row, now, sla), split: splitOf(row, now) };
}

/** Open, or done within the last 30 days: what the snapshot shows. */
export function inSnapshot(row: SlackItemRow, now: Date): boolean {
  if (!row.doneAt) return true;
  return now.getTime() - new Date(row.doneAt).getTime() <= KEEP_DONE_MS;
}

const PR_URL = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/g;

/** Every GitHub PR URL in the text, as `{ repo, number }`. */
export function prUrlsIn(text: string): { repo: string; number: number }[] {
  return [...text.matchAll(PR_URL)].map((m) => ({ repo: m[1]!, number: Number(m[2]) }));
}
