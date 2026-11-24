// The priority of a conversation, in code, from the typed answers of `conversation_assess`. No model picks a level.
// A knock-out flag at p of 0.7 or more is P0 before any scoring; otherwise each 0..2 sub-score becomes 1..3 and goes through
// `scorePriority` with the repository's weights and bands. Pure.
import { type Bands, type KnockOutFlags, type SubScoreKey, type SubScores, type Weights, knockOut, scorePriority } from "@hardness/contracts";

type Sub = { score: number; confidence: number };
type Flag = { value: boolean; p: number };

export interface ConversationAnswers {
  kind: { choice: string; confidence: number };
  needs_reply: Flag;
  production_down: Flag;
  data_loss: Flag;
  security: Flag;
  who: Sub;
  what: Sub;
  impact: Sub;
  time: Sub;
  demand: Sub;
}

export interface ScoreConfig {
  /** `conversation.confidence`. */
  confidence: number;
  scoring?: { weights: Weights; bands: Bands };
}

export interface ConversationScore {
  priority: "P0" | "P1" | "P2" | "P3";
  total: number;
  /** Each sub-score as scored (1 to 3) with its confidence. */
  subScores: Record<SubScoreKey, Sub>;
  /** The flag that decided, if one did. */
  knockOut: string | null;
  verdict: "ok" | "ask";
  kind: string;
  /** A sure yes on `needs_reply`. */
  needsReply: boolean;
}

const KEYS: SubScoreKey[] = ["who", "what", "impact", "time", "demand"];
const FLAG_BAR = 0.7;
const sure = (f: Flag): number => Math.max(f.p, 1 - f.p);

export function conversationScore(answers: ConversationAnswers, config: ScoreConfig): ConversationScore {
  const subScores = Object.fromEntries(KEYS.map((k) => [k, { score: answers[k].score + 1, confidence: answers[k].confidence }])) as Record<SubScoreKey, Sub>;
  const plain = Object.fromEntries(KEYS.map((k) => [k, subScores[k].score])) as SubScores;
  const scored = scorePriority(plain, { ...(config.scoring ?? {}), confidences: Object.fromEntries(KEYS.map((k) => [k, subScores[k].confidence])) });
  const flags: KnockOutFlags = {};
  for (const name of ["production_down", "data_loss", "security"] as const) if (answers[name].value && answers[name].p >= FLAG_BAR) flags[name] = true;
  const hit = knockOut(flags);
  return {
    priority: hit?.action === "p0" ? "P0" : scored.priority,
    total: scored.total,
    subScores,
    knockOut: hit?.action === "p0" ? hit.flag : null,
    verdict: answers.kind.confidence < config.confidence || sure(answers.needs_reply) < config.confidence ? "ask" : "ok",
    kind: answers.kind.choice,
    needsReply: answers.needs_reply.value && answers.needs_reply.p >= config.confidence,
  };
}
