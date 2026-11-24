import { describe, expect, it } from "vitest";

import { SCORING_DEFAULTS, costOfDelay, costOfDoing, knockOut, riskProduct, scorePriority, wsjf } from "./scoring.ts";
import { riskLevelOf } from "./packs.ts";

const sub = (who: number, what: number, impact: number, time: number, demand: number) => ({ who, what, impact, time, demand });

describe("scorePriority", () => {
  it("weights the sub-scores 3, 3, 2, 2, 1 and bands the sum", () => {
    // all 3: 3*3 + 3*3 + 2*3 + 2*3 + 1*3 = 9 + 9 + 6 + 6 + 3 = 33 -> P0
    expect(scorePriority(sub(3, 3, 3, 3, 3))).toMatchObject({ priority: "P0", total: 33 });
    // all 1: 3 + 3 + 2 + 2 + 1 = 11 -> P3
    expect(scorePriority(sub(1, 1, 1, 1, 1))).toMatchObject({ priority: "P3", total: 11 });
    // all 2: 6 + 6 + 4 + 4 + 2 = 22 -> P1 (22 is the P1 bar)
    expect(scorePriority(sub(2, 2, 2, 2, 2))).toMatchObject({ priority: "P1", total: 22 });
  });

  it("puts the band edges where the diagram does: 28 is P0, 27 is P1, 22 is P1, 21 is P2, 16 is P2, 15 is P3", () => {
    // 3,3,2,2,2: 9 + 9 + 4 + 4 + 2 = 28
    expect(scorePriority(sub(3, 3, 2, 2, 2)).priority).toBe("P0");
    // 3,3,2,2,1: 9 + 9 + 4 + 4 + 1 = 27
    expect(scorePriority(sub(3, 3, 2, 2, 1)).priority).toBe("P1");
    // 3,2,2,2,1: 9 + 6 + 4 + 4 + 1 = 24 -> P1; 2,2,2,2,1: 6+6+4+4+1 = 21 -> P2
    expect(scorePriority(sub(2, 2, 2, 2, 1))).toMatchObject({ priority: "P2", total: 21 });
    // 2,2,1,1,2: 6 + 6 + 2 + 2 + 2 = 18 -> P2; 2,2,1,1,1: 6+6+2+2+1 = 17 -> P2; 2,1,1,2,1: 6+3+2+4+1 = 16 -> P2
    expect(scorePriority(sub(2, 1, 1, 2, 1))).toMatchObject({ priority: "P2", total: 16 });
    // 1,2,1,2,1: 3 + 6 + 2 + 4 + 1 = 16; 2,1,1,1,2: 6 + 3 + 2 + 2 + 2 = 15 -> P3
    expect(scorePriority(sub(2, 1, 1, 1, 2))).toMatchObject({ priority: "P3", total: 15 });
  });

  it("pulls each score toward 2 by its confidence, and returns what to log", () => {
    // who 3 at confidence 0.5 -> 2 + (3 - 2) * 0.5 = 2.5 -> 3 * 2.5 = 7.5; the rest at 2: 6 + 4 + 4 + 2 = 16; total 23.5
    const r = scorePriority(sub(3, 2, 2, 2, 2), { confidences: { who: 0.5 } });
    expect(r.total).toBeCloseTo(23.5);
    expect(r.priority).toBe("P1");
    expect(r.weighted.who).toBeCloseTo(7.5);
    expect(r.subScores).toEqual(sub(3, 2, 2, 2, 2));
    // confidence 0 everywhere: every score is the neutral 2 -> 22
    expect(scorePriority(sub(3, 3, 3, 3, 3), { confidences: { who: 0, what: 0, impact: 0, time: 0, demand: 0 } }).total).toBe(22);
    // a low score pulled up: 1 at 0.5 -> 2 + (1 - 2) * 0.5 = 1.5
    expect(scorePriority(sub(1, 2, 2, 2, 2), { confidences: { who: 0.5 } }).weighted.who).toBeCloseTo(4.5);
  });

  it("takes a repo's weights and bands over the defaults", () => {
    // weights all 1, 3 each: 5 -> with bands P0 >= 15 -> P0
    const r = scorePriority(sub(3, 3, 3, 3, 3), { weights: { who: 1, what: 1, impact: 1, time: 1, demand: 1 }, bands: { P0: 15, P1: 10, P2: 6 } });
    expect(r).toMatchObject({ priority: "P0", total: 15 });
  });

  it("holds its numbers in SCORING_DEFAULTS", () => {
    expect(SCORING_DEFAULTS.weights).toEqual({ who: 3, what: 3, impact: 2, time: 2, demand: 1 });
    expect(SCORING_DEFAULTS.bands).toEqual({ P0: 28, P1: 22, P2: 16 });
  });
});

describe("knockOut", () => {
  it("sends a production outage, data loss, a security issue, an incident or a compliance deadline to P0 before any scoring", () => {
    for (const flag of ["production_down", "data_loss", "security", "incident", "compliance_deadline"] as const) {
      expect(knockOut({ [flag]: true })).toEqual({ action: "p0", flag });
    }
  });

  it("parks a bug nobody can reproduce and nobody can ask about, and does nothing otherwise", () => {
    expect(knockOut({ cant_reproduce_no_reporter: true })).toEqual({ action: "park", flag: "cant_reproduce_no_reporter" });
    expect(knockOut({})).toBeNull();
    expect(knockOut({ security: false })).toBeNull();
  });

  it("lets a P0 flag win over the park", () => {
    expect(knockOut({ cant_reproduce_no_reporter: true, data_loss: true })).toEqual({ action: "p0", flag: "data_loss" });
  });
});

describe("the backlog ranking", () => {
  it("sums cost of doing and cost of delay", () => {
    // 2 + 3 + 1 = 6
    expect(costOfDoing({ complexity: 2, blastRadius: 3, regression: 1 })).toBe(6);
    // 3 + 2 = 5
    expect(costOfDelay({ urgency: 3, compounding: 2 })).toBe(5);
  });

  it("ranks by cost of delay over cost of doing", () => {
    // 6 / 3 = 2
    expect(wsjf({ costOfDelay: costOfDelay({ urgency: 3, compounding: 3 }), costOfDoing: costOfDoing({ complexity: 1, blastRadius: 1, regression: 1 }) })).toBe(2);
    // 2 + 2 = 4 over 3 + 3 + 3 = 9
    expect(wsjf({ costOfDelay: costOfDelay({ urgency: 2, compounding: 2 }), costOfDoing: costOfDoing({ complexity: 3, blastRadius: 3, regression: 3 }) })).toBeCloseTo(4 / 9);
  });

  it("pulls a doubtful component toward 2 the same way", () => {
    // urgency 3 at 0.5 -> 2.5; compounding 3 -> 3: 5.5
    expect(costOfDelay({ urgency: { score: 3, confidence: 0.5 }, compounding: 3 })).toBeCloseTo(5.5);
    // complexity 1 at 0 -> 2: 2 + 1 + 1 = 4
    expect(costOfDoing({ complexity: { score: 1, confidence: 0 }, blastRadius: 1, regression: 1 })).toBe(4);
  });

  it("refuses a zero cost of doing", () => {
    expect(() => wsjf({ costOfDelay: 3, costOfDoing: 0 })).toThrow();
  });
});

describe("riskProduct", () => {
  const level = (b: number, r: number, d: number) => riskProduct({ blastRadius: b, reversibility: r, dataSensitivity: d });

  it("is Low up to 4, Medium from 5 to 11 and High from 12", () => {
    expect(level(1, 1, 1)).toMatchObject({ product: 1, level: "low" });
    expect(level(2, 2, 1)).toMatchObject({ product: 4, level: "low" });
    expect(level(1, 5, 1).level).toBe("medium"); // 1 * 5 * 1 = 5 (a score may be any positive number)
    expect(level(3, 3, 1)).toMatchObject({ product: 9, level: "medium" });
    expect(level(3, 2, 2)).toMatchObject({ product: 12, level: "high" });
    expect(level(3, 3, 3)).toMatchObject({ product: 27, level: "high" });
  });

  it("riskLevelOf multiplies the three levels like riskProduct does (a score runs 0 to 2: level = round + 1)", () => {
    expect(riskLevelOf({ blast_radius: { score: 0 }, reversibility: { score: 0 }, data_sensitivity: { score: 0 } })).toBe("low");
    expect(riskLevelOf({ blast_radius: { score: 2 }, reversibility: { score: 2 }, data_sensitivity: { score: 2 } })).toBe("high");
    expect(riskLevelOf({ blast_radius: { score: 0 }, reversibility: { score: 0 }, data_sensitivity: { score: 2 } })).toBe("low");
  });
});
