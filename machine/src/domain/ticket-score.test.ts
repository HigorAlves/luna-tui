import { type Bands, SCORING_DEFAULTS, type Weights } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import { type AssessAnswer, ticketScore } from "./ticket-score.ts";

// Scores are 0..2 on the pack's rubric (the code reads them as 1..3). The numbers below are worked by hand.
const s = (score: number, confidence = 1) => ({ score, confidence });
const no = { value: false, p: 0.05 };
const answers = (over: Partial<Record<keyof AssessAnswer, unknown>> = {}, level = 0, confidence = 1): AssessAnswer =>
  ({
    who: s(level, confidence), what: s(level, confidence), impact: s(level, confidence), time: s(level, confidence), demand: s(level, confidence),
    files: s(level, confidence), unknowns: s(level, confidence), cross_team: s(level, confidence), new_infra: s(level, confidence),
    dependents: s(level, confidence), traffic: s(level, confidence), data_sensitivity: s(level, confidence), reversibility: s(level, confidence),
    regression: s(level, confidence), compounding: s(level, confidence),
    production_down: no, data_loss: no, security: no, incident: no, compliance_deadline: no,
    ...over,
  }) as AssessAnswer;
const facts = { cantReproduceNoReporter: false };

describe("ticketScore", () => {
  it("scores the top of every rubric: urgency 33 is P0, complexity XL, blast radius high, cost of delay 6 over cost of doing 9", () => {
    const r = ticketScore(answers({}, 2), SCORING_DEFAULTS_CONFIG(), facts);
    expect(r).toMatchObject({ knockOut: null, parked: false, priority: "P0", urgencyTotal: 33, size: "XL", blastRadius: "high", costOfDelay: 6, costOfDoing: 9 });
    expect(r.score).toBeCloseTo(6 / 9, 6);
  });

  it("scores the bottom of every rubric: urgency 11 is P3, complexity S, blast radius low", () => {
    const r = ticketScore(answers({}, 0), SCORING_DEFAULTS_CONFIG(), facts);
    expect(r).toMatchObject({ priority: "P3", urgencyTotal: 11, size: "S", blastRadius: "low", costOfDelay: 2, costOfDoing: 3 });
  });

  it("worked mixed case: urgency 22 is P1, complexity 1.5 is M, blast 2 x 2 x 1 = 4 is low, 4 over 5 is 0.8", () => {
    const r = ticketScore(
      answers({ who: s(2), what: s(1), impact: s(1), time: s(0), demand: s(0), files: s(1), unknowns: s(1), cross_team: s(0), new_infra: s(0), dependents: s(1), traffic: s(0), data_sensitivity: s(1), reversibility: s(0), regression: s(1), compounding: s(1) }),
      SCORING_DEFAULTS_CONFIG(),
      facts,
    );
    expect(r).toMatchObject({ priority: "P1", urgencyTotal: 22, size: "M", blastRadius: "low", costOfDelay: 4, costOfDoing: 5 });
    expect(r.score).toBeCloseTo(0.8, 6);
  });

  it("pulls a doubtful reading toward neutral: all top scores at confidence 0.5 total 27.5, which is P1 not P0", () => {
    expect(ticketScore(answers({}, 2, 0.5), SCORING_DEFAULTS_CONFIG(), facts)).toMatchObject({ priority: "P1", urgencyTotal: 27.5 });
  });

  it("uses the repository's weights", () => {
    const cfg = SCORING_DEFAULTS_CONFIG();
    cfg.scoring.weights = { who: 10, what: 0, impact: 0, time: 0, demand: 0 };
    expect(ticketScore(answers({}, 2), cfg, facts)).toMatchObject({ urgencyTotal: 30, priority: "P0" });
  });

  it("goes to the top on a security or compliance deadline whatever the scores say, and names the flag", () => {
    const r = ticketScore(answers({ security: { value: true, p: 0.95 } }, 0), SCORING_DEFAULTS_CONFIG(), facts);
    expect(r).toMatchObject({ priority: "P0", parked: false, knockOut: { action: "p0", flag: "security" } });
    expect(ticketScore(answers({ compliance_deadline: { value: true, p: 0.8 } }, 0), SCORING_DEFAULTS_CONFIG(), facts).knockOut).toEqual({ action: "p0", flag: "compliance_deadline" });
  });

  it("takes a flag only when the pack is sure of it", () => {
    expect(ticketScore(answers({ security: { value: true, p: 0.55 } }, 0), SCORING_DEFAULTS_CONFIG(), facts).knockOut).toBeNull();
  });

  it("parks a bug nobody can reproduce or ask, unless a P0 flag says otherwise", () => {
    const parked = ticketScore(answers({}, 2), SCORING_DEFAULTS_CONFIG(), { cantReproduceNoReporter: true });
    expect(parked).toMatchObject({ parked: true, knockOut: { action: "park", flag: "cant_reproduce_no_reporter" } });
    expect(ticketScore(answers({ data_loss: { value: true, p: 0.9 } }, 0), SCORING_DEFAULTS_CONFIG(), { cantReproduceNoReporter: true })).toMatchObject({ parked: false, priority: "P0", knockOut: { action: "p0", flag: "data_loss" } });
  });

  it("keeps every sub-score with its confidence for the assessment history", () => {
    const r = ticketScore(answers({ who: s(2, 0.8) }, 1), SCORING_DEFAULTS_CONFIG(), facts);
    expect(r.subScores.who).toEqual({ value: 3, confidence: 0.8 });
    expect(Object.keys(r.subScores)).toHaveLength(15);
  });
});

function SCORING_DEFAULTS_CONFIG() {
  return { scoring: { weights: { ...SCORING_DEFAULTS.weights } as Weights, bands: { ...SCORING_DEFAULTS.bands } as Bands } };
}
