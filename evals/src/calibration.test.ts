import { describe, expect, it } from "vitest";

import { calibrate } from "./calibration.ts";

// Four graded decisions, at a proceed bar of 0.7:
//   confidence  correct  verdict
//   0.9         yes      proceed
//   0.8         no       proceed
//   0.6         yes      flag
//   0.4         no       ask
// accuracy        = 2 right of 4                                   = 0.5
// actedOnAccuracy = of the 2 proceed (0.9 yes, 0.8 no): 1 right    = 0.5
// coverage        = 2 proceed of 4                                 = 0.5
// brier           = ((0.9-1)^2 + (0.8-0)^2 + (0.6-1)^2 + (0.4-0)^2) / 4 = (0.01+0.64+0.16+0.16)/4 = 0.2425
// ece, five bins of width 0.2 (0.9 and 0.8 in [0.8,1], 0.6 in [0.6,0.8), 0.4 in [0.4,0.6)):
//   bin [0.8,1]: mean confidence 0.85, accuracy 0.5, gap 0.35, weight 2/4 = 0.175
//   bin [0.6,0.8): confidence 0.6, accuracy 1, gap 0.4, weight 1/4        = 0.1
//   bin [0.4,0.6): confidence 0.4, accuracy 0, gap 0.4, weight 1/4        = 0.1
//   ece = 0.375
// meanConfidence  = (0.9+0.8+0.6+0.4)/4 = 0.675
// overconfident   = confidence >= 0.7 and wrong: only the 0.8 one  = 1
const four = [
  { correct: true, confidence: 0.9, verdict: "proceed" as const },
  { correct: false, confidence: 0.8, verdict: "proceed" as const },
  { correct: true, confidence: 0.6, verdict: "flag" as const },
  { correct: false, confidence: 0.4, verdict: "ask" as const },
];

describe("calibrate", () => {
  it("computes each metric on a hand-made set", () => {
    const c = calibrate(four, { bar: 0.7 });
    expect(c.n).toBe(4);
    expect(c.labelled).toBe(4);
    expect(c.accuracy).toBeCloseTo(0.5, 10);
    expect(c.actedOnAccuracy).toBeCloseTo(0.5, 10);
    expect(c.coverage).toBeCloseTo(0.5, 10);
    expect(c.brier).toBeCloseTo(0.2425, 10);
    expect(c.ece).toBeCloseTo(0.375, 10);
    expect(c.meanConfidence).toBeCloseTo(0.675, 10);
    expect(c.overconfident).toBe(1);
  });

  it("leaves out the unlabelled from the accuracy metrics but not from coverage or confidence", () => {
    // Add one unlabelled decision at 0.95, proceed: n = 5, labelled = 4, coverage 3/5 = 0.6, meanConfidence (2.7+0.95)/5 = 0.73.
    const c = calibrate([...four, { correct: null, confidence: 0.95, verdict: "proceed" }], { bar: 0.7 });
    expect(c).toMatchObject({ n: 5, labelled: 4, overconfident: 1 });
    expect(c.accuracy).toBeCloseTo(0.5, 10);
    expect(c.coverage).toBeCloseTo(0.6, 10);
    expect(c.meanConfidence).toBeCloseTo(0.73, 10);
  });

  it("answers null for what has nothing to measure: no labels, nothing acted on, no cases", () => {
    expect(calibrate([{ correct: null, confidence: 0.9, verdict: "proceed" }], { bar: 0.7 })).toMatchObject({ n: 1, labelled: 0, accuracy: null, actedOnAccuracy: null, brier: null, ece: null, coverage: 1 });
    expect(calibrate([{ correct: true, confidence: 0.5, verdict: "ask" }], { bar: 0.7 }).actedOnAccuracy).toBeNull();
    expect(calibrate([], { bar: 0.7 })).toMatchObject({ n: 0, coverage: null, meanConfidence: null });
  });

  it("puts a confidence of exactly 1 in the top bin", () => {
    // One right answer at 1.0: no gap at all.
    expect(calibrate([{ correct: true, confidence: 1, verdict: "proceed" }], { bar: 0.7 }).ece).toBe(0);
  });
});
