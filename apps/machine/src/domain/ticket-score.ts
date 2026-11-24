// The assessment's arithmetic, in code: the pack answers fifteen typed scores and five flags; this reads them. Knock-outs first
// (a security or compliance deadline goes to the top, a bug nobody can reproduce or ask about parks), then urgency to P0-P3, complexity
// to S/M/L/XL, blast radius to low/medium/high, and the priority as cost of delay over cost of doing, each score pulled toward neutral by its
// confidence, with the repository's weights. Pure; every sub-score is kept for the history.
import { type KnockOutFlags, P0_FLAGS, type Priority, type SubScoreKey, costOfDelay, costOfDoing, knockOut, riskProduct, scorePriority, wsjf, type Weights, type Bands } from "@hardness/contracts";

type Score = { score: number; confidence: number };
type Flag = { value: boolean; p: number };

export const URGENCY_KEYS = ["who", "what", "impact", "time", "demand"] as const satisfies readonly SubScoreKey[];
export const COMPLEXITY_KEYS = ["files", "unknowns", "cross_team", "new_infra"] as const;
export const BLAST_KEYS = ["dependents", "traffic", "data_sensitivity", "reversibility"] as const;
export const RISK_KEYS = ["regression", "compounding"] as const;
export const SCORE_KEYS = [...URGENCY_KEYS, ...COMPLEXITY_KEYS, ...BLAST_KEYS, ...RISK_KEYS] as const;
export const FLAG_KEYS = P0_FLAGS;

export type AssessAnswer = Record<(typeof SCORE_KEYS)[number], Score> & Record<(typeof P0_FLAGS)[number], Flag>;

export type TicketSize = "S" | "M" | "L" | "XL";

export interface SubScore {
  /** 1 to 3, read from the pack's 0 to 2 place on the rubric. */
  value: number;
  confidence: number;
}

export interface TicketScoreResult {
  knockOut: { action: "p0" | "park"; flag: string } | null;
  /** True when a knock-out parked the ticket: it is not scheduled or done now. */
  parked: boolean;
  priority: Priority;
  /** The weighted urgency total the P level was read from. */
  urgencyTotal: number;
  size: TicketSize;
  blastRadius: "low" | "medium" | "high";
  costOfDelay: number;
  costOfDoing: number;
  /** Cost of delay over cost of doing: the backlog's rank. */
  score: number;
  subScores: Record<(typeof SCORE_KEYS)[number], SubScore>;
}

/** A flag counts only when the pack is this sure of it. */
export const FLAG_BAR = 0.7;

const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
const sizeOf = (avg: number): TicketSize => (avg < 1.5 ? "S" : avg < 2.25 ? "M" : avg < 2.75 ? "L" : "XL");

export function ticketScore(
  answers: AssessAnswer,
  config: { scoring: { weights: Weights; bands: Bands } },
  facts: { cantReproduceNoReporter: boolean },
): TicketScoreResult {
  const subScores = Object.fromEntries(SCORE_KEYS.map((k) => [k, { value: 1 + answers[k].score, confidence: answers[k].confidence }])) as TicketScoreResult["subScores"];
  const flags: KnockOutFlags = Object.fromEntries(P0_FLAGS.map((f) => [f, answers[f].p >= FLAG_BAR]));
  flags.cant_reproduce_no_reporter = facts.cantReproduceNoReporter;
  const hit = knockOut(flags);

  const urgency = scorePriority(Object.fromEntries(URGENCY_KEYS.map((k) => [k, subScores[k].value])) as Record<SubScoreKey, number>, {
    weights: config.scoring.weights,
    bands: config.scoring.bands,
    confidences: Object.fromEntries(URGENCY_KEYS.map((k) => [k, subScores[k].confidence])),
  });
  const weightSum = URGENCY_KEYS.reduce((a, k) => a + config.scoring.weights[k], 0);
  const urgencyValue = weightSum > 0 ? urgency.total / weightSum : 2;

  const group = (keys: readonly (typeof SCORE_KEYS)[number][]) => ({ score: mean(keys.map((k) => subScores[k].value)), confidence: mean(keys.map((k) => subScores[k].confidence)) });
  const complexity = group(COMPLEXITY_KEYS);
  const blast = group(["dependents", "traffic"]);
  const delay = costOfDelay({ urgency: { score: urgencyValue, confidence: 1 }, compounding: { score: subScores.compounding.value, confidence: subScores.compounding.confidence } });
  const doing = costOfDoing({ complexity, blastRadius: blast, regression: { score: subScores.regression.value, confidence: subScores.regression.confidence } });

  const risk = riskProduct({ blastRadius: Math.round(blast.score), reversibility: subScores.reversibility.value, dataSensitivity: subScores.data_sensitivity.value });
  return {
    knockOut: hit,
    parked: hit?.action === "park",
    priority: hit?.action === "p0" ? "P0" : urgency.priority,
    urgencyTotal: urgency.total,
    size: sizeOf(complexity.score),
    blastRadius: risk.level,
    costOfDelay: delay,
    costOfDoing: doing,
    score: wsjf({ costOfDelay: delay, costOfDoing: doing }),
    subScores,
  };
}
