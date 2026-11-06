// The conversation reply pack's template variables. Their kinds are declared once, in `VARIABLES` (data-block.ts), like every other variable:
// `relation` and `note` are the machine's own words, the rest is foreign text and the renderer quotes it in a data block. This file only
// says what each variable holds; it quotes nothing itself.
import type { ConversationContext } from "@hardness/contracts";

import { DATA_NOTE, VARIABLES, type VariableKind } from "./data-block.ts";

const PREFIX = "context.conversation.";

/** The names of the `{{context.conversation.*}}` variables, with their declared kinds: read from `VARIABLES`, not a list of its own. */
export const CONVERSATION_VARIABLES: Readonly<Record<string, VariableKind>> = Object.freeze(
  Object.fromEntries(Object.entries(VARIABLES).filter(([name]) => name.startsWith(PREFIX)).map(([name, kind]) => [name.slice(PREFIX.length), kind])),
);

const NONE = "(none)";

export function conversationText(context: ConversationContext): Record<string, string> {
  const reply = context.reply;
  const lines = (items: string[]): string => (items.length > 0 ? items.join("\n") : NONE);
  const values: Record<string, string> = {
    thread: lines(context.thread),
    card: reply?.card ? reply.card : NONE,
    evidence: reply?.evidence ? reply.evidence : NONE,
    docs: lines(reply?.docs ?? []),
    tone: lines((reply?.tone ?? []).flatMap((t, i) => [`example ${i + 1}, the machine wrote: ${t.machine}`, `example ${i + 1}, the person sent: ${t.person}`])),
    memory: lines(reply?.memory ?? []),
    relation: reply?.relation ?? "none",
    note: DATA_NOTE,
  };
  return Object.fromEntries(Object.entries(values).map(([name, value]) => [`{{${PREFIX}${name}}}`, value]));
}
