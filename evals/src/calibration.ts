// How well a decision pack's confidence tracks its being right, over a scorecard's cases (RFC 0005
// wave 7). Pure. A case with no label counts toward coverage and mean confidence but not toward the
// accuracy metrics: nothing says whether it was right.
import type { Verdict } from "@hardness/contracts";

export interface DecisionGrade {
  /** Every labelled question matched; null when the case has no label. */
  correct: boolean | null;
  /** The answer's confidence, the mean over its questions. */
  confidence: number;
  /** The pack's own bars applied to the answer. */
  verdict: Verdict;
}

export interface Calibration {
  /** Graded answers, and the ones with a label. */
  n: number;
  labelled: number;
  /** Right over labelled. */
  accuracy: number | null;
  /** Right among the labelled ones the policy would have acted on (`proceed`). */
  actedOnAccuracy: number | null;
  /** Share of answers that were `proceed`. */
  coverage: number | null;
  /** Mean (confidence - correct)^2 over the labelled. */
  brier: number | null;
  /** Expected calibration error over the labelled, five equal-width bins. */
  ece: number | null;
  meanConfidence: number | null;
  /** Wrong at or above the proceed bar: the costly kind. */
  overconfident: number;
}

export const ECE_BINS = 5;

const mean = (values: number[]): number | null => (values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length);

export function calibrate(grades: DecisionGrade[], options: { bar: number }): Calibration {
  const labelled = grades.filter((g): g is DecisionGrade & { correct: boolean } => g.correct !== null);
  const acted = labelled.filter((g) => g.verdict === "proceed");
  const bins: Array<Array<DecisionGrade & { correct: boolean }>> = Array.from({ length: ECE_BINS }, () => []);
  for (const g of labelled) bins[Math.min(ECE_BINS - 1, Math.floor(g.confidence * ECE_BINS))]!.push(g);
  return {
    n: grades.length,
    labelled: labelled.length,
    accuracy: mean(labelled.map((g) => (g.correct ? 1 : 0))),
    actedOnAccuracy: mean(acted.map((g) => (g.correct ? 1 : 0))),
    coverage: mean(grades.map((g) => (g.verdict === "proceed" ? 1 : 0))),
    brier: mean(labelled.map((g) => (g.confidence - (g.correct ? 1 : 0)) ** 2)),
    ece: labelled.length === 0 ? null : bins.reduce((sum, bin) => sum + (bin.length === 0 ? 0 : (bin.length / labelled.length) * Math.abs(mean(bin.map((g) => (g.correct ? 1 : 0)))! - mean(bin.map((g) => g.confidence))!)), 0),
    meanConfidence: mean(grades.map((g) => g.confidence)),
    overconfident: labelled.filter((g) => !g.correct && g.confidence >= options.bar).length,
  };
}
