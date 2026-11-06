// The Conversation Machine's chain behind the inbox: enrich by script, one `conversation_assess` call, the priority in code, then the
// `SlackTriage` the board already reads. A failed call throws (the inbox retries it on TRIAGE_RETRY_MS). Nothing here posts or makes a card.
import type { ConversationClassification, ConversationRelation, FactoryConfig, SlackTriage } from "@hardness/contracts";

import { type RelationAnswers, relationOf } from "../domain/conversation-relation.ts";
import { type ConversationAnswers, conversationScore } from "../domain/conversation-score.ts";
import type { SlackItemRow } from "../domain/slack-item.ts";
import { firstLine } from "../domain/slack-rules.ts";
import { prUrlsIn } from "../domain/slack-item.ts";
import type { Enriched } from "./conversation-enrich.ts";

export interface MachineDeps {
  enrich(row: SlackItemRow): Promise<Enriched>;
  /** The one call of the `conversation_assess` pack: `packRuns.run(..., INTAKE_CLIENT)`. */
  decide(context: Enriched["context"]): Promise<{ answer: unknown; recordId?: string }>;
  /** The one call of the `conversation_relation` pack, over the same context. */
  decideRelation(context: Enriched["context"]): Promise<{ answer: unknown; recordId?: string }>;
  config(channel: string): { conversation: FactoryConfig["conversation"]; scoring: FactoryConfig["scoring"] };
  now?: () => Date;
}

export interface Assessed {
  triage: SlackTriage;
  classification: ConversationClassification;
  verdict: "ok" | "ask";
  /** Null when the verdict is `ask`: the relation is asked only of a thread the machine is sure about. */
  relation: ConversationRelation | null;
  shortlist: Enriched["shortlist"];
}

export const CATEGORY: Record<string, SlackTriage["category"]> = { incident: "blocker", bug: "request", request: "request", question: "question", fyi: "fyi", chatter: "social" };

export class ConversationMachine {
  constructor(private readonly deps: MachineDeps) {}

  async assess(row: SlackItemRow): Promise<Assessed> {
    const now = (this.deps.now?.() ?? new Date()).toISOString();
    const settings = this.deps.config(row.channel.id);
    const enriched = await this.deps.enrich(row);
    const { answer, recordId } = await this.deps.decide(enriched.context);
    const score = conversationScore(answer as ConversationAnswers, { confidence: settings.conversation.confidence, scoring: settings.scoring });
    const sub = (["who", "what", "impact", "time", "demand"] as const).map((k) => `${k} ${score.subScores[k].score}`).join(", ");
    const triage: SlackTriage = {
      priority: score.priority,
      category: CATEGORY[score.kind] ?? "fyi",
      expectsReply: score.needsReply,
      summary: firstLine(row.text),
      why: score.knockOut ? `${score.kind}; ${score.knockOut}` : `${score.kind}; ${sub}; total ${score.total}`,
      draft: null,
      refs: prUrlsIn(row.text).map((r) => ({ kind: "pr" as const, ref: `${r.repo}#${r.number}` })),
      deadline: null,
      by: "model",
      triagedAt: now,
      overridden: false,
    };
    const classification: ConversationClassification = {
      kind: score.kind,
      confidence: (answer as ConversationAnswers).kind.confidence,
      by: "model",
      at: now,
      records: recordId ? { assess: recordId } : {},
      verdict: score.verdict,
      priority: score.priority,
      total: score.total,
      knockOut: score.knockOut,
      scores: score.subScores,
    };
    // The relation, after the score: a knock-out P0 still gets one; chatter is none with no call; an unsure verdict asks a person first.
    let relation: ConversationRelation | null = null;
    if (score.verdict === "ok") {
      if (score.kind === "chatter") relation = { type: "none", target: null, confidence: classification.confidence, by: "model", at: now };
      else {
        const asked = await this.deps.decideRelation(enriched.context);
        const verdict = relationOf(asked.answer as RelationAnswers, enriched.shortlist, score.kind, settings.conversation.confidence);
        relation = { type: verdict.type, target: verdict.target, confidence: verdict.confidence, by: "model", at: now, ...(asked.recordId ? { record: asked.recordId } : {}), ...(verdict.otherSource ? { otherSource: verdict.otherSource } : {}) };
        if (asked.recordId) classification.records.relation = asked.recordId;
      }
    }
    return { triage, classification, verdict: score.verdict, relation, shortlist: enriched.shortlist };
  }
}
