// A stored conversation row for tests: one message folded in, the way the poller stores it.
import type { ChannelKind } from "@hardness/contracts";

import { canonicalMessageOf, emptyConversation, foldMessage } from "../domain/conversation.ts";
import type { SlackItemRow } from "../domain/slack-item.ts";

export function conversationRow(over: { text?: string; kind?: ChannelKind; repo?: string | null; id?: string; author?: string } = {}): SlackItemRow {
  const text = over.text ?? "checkout is down for everyone";
  const channel = { id: "C1", name: "eng", kind: over.kind ?? "channel" } as const;
  const author = { id: over.author ?? "U2", name: "marta", isBot: false };
  const folded = foldMessage(emptyConversation(channel), canonicalMessageOf({ ts: "1700000000.000000", user: author.id, botId: null, text, subtype: null, threadTs: null, replyCount: 0, latestReply: null }, { channel, author, permalink: "https://x.slack.com/p1" }));
  const conversation = { ...folded, repo: over.repo === undefined ? "/r/app" : over.repo };
  return { id: over.id ?? "C1:1700000000.000000", kind: "mention", channel, author, text, threadTs: null, context: [], permalink: "https://x.slack.com/p1", ts: "2026-10-28T12:00:00.000Z", slackTs: "1700000000.000000", matched: ["me"], count: 1, replies: 0, youReplied: false, seenAt: null, doneAt: null, snoozedUntil: null, reopenedAt: null, repliedAt: null, arrivedAt: "2026-10-28T12:00:00.000Z", triage: null, linked: { pr: null, taskId: null }, conversation } as SlackItemRow;
}
