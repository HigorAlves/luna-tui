import { describe, expect, it } from "vitest";

import { proposalCandidates } from "./candidates.ts";
import type { AgentRow } from "./scorecard.ts";

const row = (over: Partial<AgentRow>): AgentRow => ({ pack: "plan", engine: "claude:sonnet", effort: "medium", n: 5, passRate: 0.8, meanTurns: 4, costPerCase: 0.2, at: "2026-11-10T00:00:00.000Z", ...over });

describe("proposalCandidates", () => {
  it("turns an agent row into a candidate: quality is the pass rate, the effort is the row's", () => {
    expect(proposalCandidates([row({})], {})).toEqual({ plan: [{ engine: "claude:sonnet", effort: "medium", n: 5, quality: 0.8, costPerCase: 0.2, at: "2026-11-10T00:00:00.000Z" }] });
  });

  it("carries the scorecard's model, so the machine can refuse a card from before a model swap", () => {
    expect(proposalCandidates([row({ model: "claude-sonnet-5-5" })], {}).plan?.[0]).toMatchObject({ model: "claude-sonnet-5-5" });
    expect(proposalCandidates([row({ model: null })], {}).plan?.[0]).toMatchObject({ model: null });
  });

  it("skips an agent row with no cost", () => {
    expect(proposalCandidates([row({ costPerCase: null })], {})).toEqual({});
  });

  it("groups rows by pack", () => {
    const got = proposalCandidates([row({}), row({ engine: "claude:opus", effort: "low" }), row({ pack: "decompose" })], {});
    expect(got.plan).toHaveLength(2);
    expect(got.decompose).toHaveLength(1);
  });

  it("reads a decision pack's scorecard: quality is the acted-on accuracy, the effort is null", () => {
    const defaults = {
      risk_score: { measuredAt: "2026-11-06", scorecard: { "claude:haiku": { n: 8, actedOnAccuracy: 1, costPerCase: 0.0007 }, "codex:luna": { n: 8, actedOnAccuracy: 0.8, costPerCase: null }, jev: { n: 8, actedOnAccuracy: null, costPerCase: 0.00005 } } },
    };
    expect(proposalCandidates([], defaults)).toEqual({ risk_score: [{ engine: "claude:haiku", effort: null, n: 8, quality: 1, costPerCase: 0.0007, at: "2026-11-06" }] });
  });

  it("ignores an entry whose pack or engine is unknown", () => {
    expect(proposalCandidates([], { nope: { measuredAt: "2026-11-06", scorecard: { "claude:haiku": { n: 8, actedOnAccuracy: 1, costPerCase: 1 } } }, risk_score: { measuredAt: "2026-11-06", scorecard: { "bad:engine": { n: 8, actedOnAccuracy: 1, costPerCase: 1 } } } })).toEqual({});
  });
});
