// Which relation an answer of `conversation_relation` means, by script. A slot is trusted only when the stored shortlist holds it:
// the model names a number, the machine holds the ids. Pure.
import type { ConversationRelationType } from "@hardness/contracts";

import type { ShortlistEntry } from "../application/conversation-enrich.ts";

export interface RelationAnswers {
  related: { choice: string; confidence: number };
  new_work: { value: boolean; p: number };
}

export interface RelationVerdict {
  type: ConversationRelationType;
  target: string | null;
  confidence: number;
  /** Where a ticket-sourced target came from; the board says so before a tap. */
  otherSource: ShortlistEntry["otherSource"];
}

const NEW_WORK_KINDS = new Set(["incident", "bug", "request"]);
const sure = (p: number): number => Math.max(p, 1 - p);

export function relationOf(answer: RelationAnswers, shortlist: ShortlistEntry[], kind: string, bar: number): RelationVerdict {
  const confidence = answer.related.confidence;
  const ask: RelationVerdict = { type: "ask", target: null, confidence, otherSource: null };
  if (confidence < bar) return ask;
  if (answer.related.choice === "none") {
    const asksNew = answer.new_work.value && answer.new_work.p >= bar && NEW_WORK_KINDS.has(kind);
    return { type: asksNew ? "new_candidate" : "none", target: null, confidence: asksNew ? Math.min(confidence, sure(answer.new_work.p)) : confidence, otherSource: null };
  }
  const slot = /^slot([1-5])$/.exec(answer.related.choice);
  const entry = slot ? shortlist.find((e) => e.slot === Number(slot[1])) : undefined;
  if (!entry) return ask;
  return { type: entry.kind === "backlog" ? "related_to_backlog" : "related_to_in_progress", target: entry.id, confidence, otherSource: entry.otherSource };
}
