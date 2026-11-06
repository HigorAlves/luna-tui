import { describe, expect, it } from "vitest";

import { recommend } from "./ticket-recommend.ts";
import type { TicketScoreResult } from "./ticket-score.ts";

const score = (over: Partial<TicketScoreResult> = {}): TicketScoreResult => ({ knockOut: null, parked: false, priority: "P2", urgencyTotal: 18, size: "M", blastRadius: "low", costOfDelay: 4, costOfDoing: 6, score: 4 / 6, subScores: {} as TicketScoreResult["subScores"], ...over });

describe("recommend, where the scores decide", () => {
  it("does now what a knock-out sent to the top, whatever else it costs", () => {
    expect(recommend(score({ knockOut: { action: "p0", flag: "security" }, priority: "P0", size: "XL", score: 0.3 }))).toMatchObject({ action: "do_now" });
  });

  it("asks a person about a high blast radius, and about a park", () => {
    expect(recommend(score({ blastRadius: "high", priority: "P1", score: 2 }))).toMatchObject({ action: "needs_decision" });
    expect(recommend(score({ parked: true, knockOut: { action: "park", flag: "cant_reproduce_no_reporter" } }))).toMatchObject({ action: "needs_decision" });
  });

  it("names split for an XL ticket and leaves it to the decomposition", () => {
    expect(recommend(score({ size: "XL", priority: "P1", score: 1.2 }))).toMatchObject({ action: "split" });
  });

  it("puts cost of doing against cost of delay: P0/P1 at or above 1 is now, below 1 is a decision", () => {
    expect(recommend(score({ priority: "P1", score: 1 }))).toMatchObject({ action: "do_now" });
    expect(recommend(score({ priority: "P0", score: 0.9 }))).toMatchObject({ action: "needs_decision" });
  });

  it("schedules what is worth doing but not urgent, and declines what is neither", () => {
    expect(recommend(score({ priority: "P2", score: 0.7 }))).toMatchObject({ action: "schedule" });
    expect(recommend(score({ priority: "P3", score: 0.4 }))).toMatchObject({ action: "decline" });
  });

  it("says it cannot tell in between, so the typed decision is asked", () => {
    expect(recommend(score({ priority: "P2", score: 0.5 }))).toBeNull();
    expect(recommend(score({ priority: "P3", score: 0.55 }))).toBeNull();
  });
});
