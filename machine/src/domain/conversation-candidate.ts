// What a conversation becomes when it turns into a card or a backlog item: a title and a text, by script. The thread is a stranger's: masked,
// flattened to one line per message and capped. A private conversation (a private channel, a DM, a group DM) gives no text at all.
import { MESSAGE_CAPS } from "@hardness/contracts";

import { maskPii } from "./secrets-check.ts";
import type { SlackItemRow } from "./slack-item.ts";

export const TITLE_CAP = 300;
export const TEXT_CAP = 4000;
const PRIVATE_TITLE = "A private Slack conversation";

const flat = (text: string): string => maskPii(text).replace(/\s+/g, " ").trim();

export function candidateOf(row: SlackItemRow): { title: string; text: string } {
  const isPrivate = row.conversation?.private ?? row.channel.kind !== "channel";
  if (isPrivate) return { title: PRIVATE_TITLE, text: `${PRIVATE_TITLE}: open it in Slack.${row.permalink ? ` ${row.permalink}` : ""}` };
  const first = row.text.split("\n").find((l) => l.trim() !== "") ?? row.text;
  const history = (row.conversation?.history ?? []).filter((m) => !m.deleted && m.text !== "").slice(-MESSAGE_CAPS.history);
  const lines = history.length > 0 ? history.map((m) => `> ${flat(m.author.name)}: ${flat(m.text)}`) : [`> ${flat(row.author.name)}: ${flat(row.text)}`];
  return { title: flat(first).slice(0, TITLE_CAP) || "A Slack thread", text: lines.join("\n").slice(0, TEXT_CAP) };
}
