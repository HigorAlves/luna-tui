// The conversation machine's pure part: a raw chat message becomes the canonical one.
import { type CanonicalMessage, type ChannelKind, MESSAGE_CAPS } from "@hardness/contracts";

import type { RawMessage } from "../application/slack.ts";
import { screen } from "./secrets-check.ts";

export interface MessageContext {
  channel: { id: string; name: string; kind: ChannelKind };
  author: { id: string; name: string; isBot: boolean };
  permalink: string;
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
    text: screen(raw.text).text.slice(0, MESSAGE_CAPS.text),
    attachments: (raw.files ?? []).slice(0, MESSAGE_CAPS.attachments).map((f) => ({ id: f.id, name: f.name, kind: f.kind })),
    mentions,
    permalink: ctx.permalink,
    ts: raw.ts,
    editedAt: raw.editedTs ? slackTsToIso(raw.editedTs) : null,
    deleted: false,
  };
}
