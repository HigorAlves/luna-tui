// The v2.2 diagram's scoring model, as pure functions: priority from five weighted sub-scores,
// knock-outs, the backlog's cost of delay over cost of doing, and risk as a product. Every number comes
// from SCORING_DEFAULTS, which luna.yaml's `scoring` section overrides (config-v22.ts). Nothing here is
// read by the pipeline before wave 9 (triage and plan), 14 (the backlog) and 15 (size).

export const SCORING_DEFAULTS = {
  /** The neutral score a doubtful one is pulled toward. */
  neutral: 2,
  weights: { who: 3, what: 3, impact: 2, time: 2, demand: 1 },
  /** A total at or above the bar is that priority; below the P2 bar is P3. */
  bands: { P0: 28, P1: 22, P2: 16 },
  /** Risk as a product of blast radius, reversibility and data sensitivity: up to `lowMax` Low, from `highMin` High, Medium between. */
  risk: { lowMax: 4, highMin: 12 },
} as const;

export type SubScoreKey = keyof typeof SCORING_DEFAULTS.weights;
export type SubScores = Record<SubScoreKey, number>;
export type Weights = Record<SubScoreKey, number>;
export type Bands = { P0: number; P1: number; P2: number };
export type Priority = "P0" | "P1" | "P2" | "P3";

/** A score pulled toward the neutral by how sure the reading is: `2 + (score - 2) * confidence`. */
const pulled = (score: number, confidence = 1): number => SCORING_DEFAULTS.neutral + (score - SCORING_DEFAULTS.neutral) * confidence;

export function scorePriority(
  subScores: SubScores,
  options: { weights?: Weights; bands?: Bands; confidences?: Partial<Record<SubScoreKey, number>> } = {},
): { priority: Priority; total: number; subScores: SubScores; weighted: Record<SubScoreKey, number> } {
  const weights = options.weights ?? SCORING_DEFAULTS.weights;
  const bands = options.bands ?? SCORING_DEFAULTS.bands;
  const keys = Object.keys(SCORING_DEFAULTS.weights) as SubScoreKey[];
  const weighted = Object.fromEntries(keys.map((k) => [k, weights[k] * pulled(subScores[k], options.confidences?.[k])])) as Record<SubScoreKey, number>;
  const total = keys.reduce((sum, k) => sum + weighted[k], 0);
  const priority: Priority = total >= bands.P0 ? "P0" : total >= bands.P1 ? "P1" : total >= bands.P2 ? "P2" : "P3";
  return { priority, total, subScores, weighted };
}

export const P0_FLAGS = ["production_down", "data_loss", "security", "incident", "compliance_deadline"] as const;
export type KnockOutFlags = Partial<Record<(typeof P0_FLAGS)[number] | "cant_reproduce_no_reporter", boolean>>;

/** A flag that decides before any scoring: P0, or park a bug nobody can reproduce or ask about. A P0 flag wins over the park. */
export function knockOut(flags: KnockOutFlags): { action: "p0" | "park"; flag: string } | null {
  const hit = P0_FLAGS.find((f) => flags[f] === true);
  if (hit) return { action: "p0", flag: hit };
  return flags.cant_reproduce_no_reporter === true ? { action: "park", flag: "cant_reproduce_no_reporter" } : null;
}

/** A 1 to 3 score, or one with the confidence that pulls it toward 2. */
export type Scored = number | { score: number; confidence?: number };
const valueOf = (s: Scored): number => (typeof s === "number" ? s : pulled(s.score, s.confidence));

export const costOfDoing = (p: { complexity: Scored; blastRadius: Scored; regression: Scored }): number => valueOf(p.complexity) + valueOf(p.blastRadius) + valueOf(p.regression);
export const costOfDelay = (p: { urgency: Scored; compounding: Scored }): number => valueOf(p.urgency) + valueOf(p.compounding);

/** The backlog's rank: cost of delay over cost of doing. */
export function wsjf(p: { costOfDelay: number; costOfDoing: number }): number {
  if (!(p.costOfDoing > 0)) throw new RangeError("cost of doing must be above zero");
  return p.costOfDelay / p.costOfDoing;
}

/** The diagram's risk: the product of the three scores (blast radius, reversibility, data sensitivity). `riskLevelOf` (packs.ts) adds them instead and stays until wave 9. */
export function riskProduct(p: { blastRadius: number; reversibility: number; dataSensitivity: number }): { product: number; level: "low" | "medium" | "high" } {
  const product = p.blastRadius * p.reversibility * p.dataSensitivity;
  return { product, level: product <= SCORING_DEFAULTS.risk.lowMax ? "low" : product >= SCORING_DEFAULTS.risk.highMin ? "high" : "medium" };
}
