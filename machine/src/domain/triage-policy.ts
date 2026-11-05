// What triage does with each signal's confidence: proceed, flag it (shown at the plan gate) or ask the person.
// The bars are the diagram's `triage.confidence`, a flag band under each; a repo's `policy.decisions.triage_signals`
// wins per question. A filer's hints move a field's confidence by `hint_weight`, never past half. Pure.
import { type CardHints, type DecisionOverrides, type FactoryConfig, HINT_WEIGHT, type TaskClassification } from "@hardness/contracts";

export type Verdict = "proceed" | "flag" | "ask";
export type TriageField = "kind" | "size" | "urgency" | "risk" | "archive";
export interface FieldVerdict {
  field: TriageField;
  verdict: Verdict;
  /** After a hint, when one was given; for urgency the lowest of its five sub-scores'. */
  confidence: number;
  /** The model's reading in words. */
  guess: string;
}

const SUB_SCORES = ["who", "what", "impact", "time", "demand"] as const;
const ORDER: Record<Verdict, number> = { proceed: 0, flag: 1, ask: 2 };
const round = (n: number) => Math.round(n * 1e6) / 1e6;

export interface TriageOptions {
  /** `policy.decisions.triage_signals`: bars by question name (`kind`, `size`, `who`... `risk_prelim`, `archive`). */
  overrides?: DecisionOverrides;
  /** What the filer said about the card; absent while the machine does not store them (wave 14). */
  hints?: CardHints;
}

export function triageVerdicts(c: TaskClassification, config: FactoryConfig["triage"], options: TriageOptions = {}): Record<TriageField, FieldVerdict> {
  const weight = Math.min(config.hint_weight, HINT_WEIGHT);
  const bar = (question: string, proceed: number) => {
    const own = options.overrides?.[question];
    const p = own?.proceed ?? proceed;
    return { proceed: p, flag: own?.flag ?? round(p - config.flag_band) };
  };
  const hinted = (confidence: number, hint: string | undefined, reading: string | undefined): number => {
    if (hint === undefined || reading === undefined) return confidence;
    return hint.trim().toLowerCase() === reading.toLowerCase() ? confidence + (1 - confidence) * weight : confidence * (1 - weight);
  };
  const judge = (confidence: number, limits: { proceed: number; flag: number }): Verdict => (confidence >= limits.proceed ? "proceed" : confidence >= limits.flag ? "flag" : "ask");
  const signals = c.signals ?? {};
  const read = (name: string, fallback: number): number => signals[name]?.confidence ?? fallback;

  const kindConfidence = hinted(read("kind", c.kindConfidence ?? c.confidence), options.hints?.kind, c.kind);
  const sizeConfidence = hinted(read("size", c.confidence), options.hints?.size, c.sizeBucket);
  const riskConfidence = hinted(read("risk_prelim", c.confidence), options.hints?.risk, c.riskPrelim);
  const archiveConfidence = read("archive", c.confidence);

  // Urgency: each sub-score against its own bar; the field is the worst of them and shows the lowest confidence.
  const subs = SUB_SCORES.map((name) => ({ confidence: read(name, c.confidence), verdict: judge(read(name, c.confidence), bar(name, config.confidence.urgency)) }));
  const worstSub = subs.reduce((worst, s) => (ORDER[s.verdict] > ORDER[worst.verdict] ? s : worst), subs[0]!);
  const lowest = Math.min(...subs.map((s) => s.confidence));
  const urgencyConfidence = hinted(lowest, options.hints?.urgency, c.priority);
  const urgencyVerdict: Verdict = options.hints?.urgency === undefined ? worstSub.verdict : judge(urgencyConfidence, bar("who", config.confidence.urgency));

  return {
    kind: { field: "kind", verdict: judge(kindConfidence, bar("kind", config.confidence.kind)), confidence: kindConfidence, guess: c.kind },
    size: { field: "size", verdict: judge(sizeConfidence, bar("size", config.confidence.size)), confidence: sizeConfidence, guess: c.sizeBucket ?? String(c.size) },
    urgency: { field: "urgency", verdict: urgencyVerdict, confidence: urgencyConfidence, guess: c.priority ?? "unknown" },
    risk: { field: "risk", verdict: judge(riskConfidence, bar("risk_prelim", config.confidence.risk)), confidence: riskConfidence, guess: c.riskPrelim ?? "unknown" },
    archive: { field: "archive", verdict: judge(archiveConfidence, bar("archive", config.confidence.archive)), confidence: archiveConfidence, guess: c.archive ? "yes" : "no" },
  };
}

export interface AskedQuestion {
  field: TriageField;
  guess: string;
  confidence: number;
  question: string;
  recommended: string;
}

const QUESTION: Record<TriageField, string> = {
  kind: "Is this a bug or a feature?",
  size: "How big is the change: XS, S, M, L or XL?",
  urgency: "How urgent is it: P0 (now), P1, P2 or P3 (whenever)?",
  risk: "How risky is the change: low, medium or high?",
  archive: "Should this be archived instead of worked?",
};

/** One question to the person for each field at `ask`: the field, the model's guess and how sure it was. The guess is the default. */
export function askedQuestions(verdicts: Record<TriageField, FieldVerdict>): AskedQuestion[] {
  return Object.values(verdicts)
    .filter((v) => v.verdict === "ask")
    .map((v) => ({ field: v.field, guess: v.guess, confidence: v.confidence, question: `${QUESTION[v.field]} The model read it as ${v.field === "kind" ? "a " : ""}${v.guess}, ${v.confidence.toFixed(2)}`, recommended: v.guess }));
}
