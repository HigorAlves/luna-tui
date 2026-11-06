// The reply pack's template variables, each declared with its kind: `machine` is the machine's own word (never quoted), `block` is foreign text
// in a data block whose markers the text cannot produce. The renderer throws on a `{{context.conversation.*}}` this list does not hold.
import type { ConversationContext } from "@hardness/contracts";

import { DATA_NOTE, dataBlock } from "./data-block.ts";

export type ConversationVariableKind = "machine" | "block";

export const CONVERSATION_VARIABLES: Record<string, ConversationVariableKind> = {
  thread: "block",
  card: "block",
  evidence: "block",
  docs: "block",
  tone: "block",
  relation: "machine",
  note: "machine",
};

const NONE = "(none)";

export function conversationText(context: ConversationContext): Record<string, string> {
  const reply = context.reply;
  const named = (name: string, items: string[]): string => (items.length > 0 ? dataBlock(name, items.join("\n")) : NONE);
  const values: Record<string, string> = {
    thread: named("thread", context.thread),
    card: reply?.card ? dataBlock("card", reply.card) : NONE,
    evidence: reply?.evidence ? dataBlock("evidence", reply.evidence) : NONE,
    docs: named("docs", reply?.docs ?? []),
    tone: named("tone", (reply?.tone ?? []).flatMap((t, i) => [`example ${i + 1}, the machine wrote: ${t.machine}`, `example ${i + 1}, the person sent: ${t.person}`])),
    relation: reply?.relation ?? "none",
    note: DATA_NOTE,
  };
  return Object.fromEntries(Object.entries(values).map(([name, value]) => [`{{context.conversation.${name}}}`, value]));
}
