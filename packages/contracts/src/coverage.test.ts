import { describe, expect, it } from "vitest";

import { coverageOf, namesLimitOrError } from "./coverage.ts";
import { type Scenario, criteriaOf } from "./plan.ts";

const scenario = (id: string, ref: string | null, type: Scenario["type"] = "happy", over: Partial<Scenario> = {}): Scenario => ({ id, title: id, criterion: null, criterion_ref: ref, approach: "a", type, ...over });

describe("coverageOf", () => {
  // Five criteria: C1 has a happy and an edge scenario, C2 names a limit and has only a happy one, C3 has none,
  // C4 has a happy one and names no limit, C5 has none and is judged untestable.
  const criteria = criteriaOf(["Cart totals add up", "The account locks after five failed logins", "Coupons expire", "The page has a title", "Everyone is happy"]);
  const scenarios = [scenario("S1", "C1"), scenario("S2", "C1", "edge"), scenario("S3", "C2"), scenario("S4", "C4")];

  it("lists per criterion the scenarios that name it and their types", () => {
    const { per } = coverageOf(criteria, scenarios);
    expect(per.map((p) => [p.criterion.id, p.scenarios, p.types, p.covered])).toEqual([
      ["C1", ["S1", "S2"], ["happy", "edge"], true],
      ["C2", ["S3"], ["happy"], true],
      ["C3", [], [], false],
      ["C4", ["S4"], ["happy"], true],
      ["C5", [], [], false],
    ]);
  });

  it("finds the gaps (no scenario) and the thin criteria (a limit or an error named, no edge or failure scenario)", () => {
    const result = coverageOf(criteria, scenarios);
    expect(result.gaps).toEqual(["C3", "C5"]);
    // C2 names a limit ("five failed"); C3 names an expiry but has no scenario at all, so it is a gap, not thin.
    expect(result.thin).toEqual(["C2"]);
  });

  it("scores covered criteria over all of them: 3 of 5 is 0.6", () => {
    expect(coverageOf(criteria, scenarios).score).toBeCloseTo(0.6, 10);
    expect(coverageOf(criteria, []).score).toBe(0);
    expect(coverageOf(criteria, [...scenarios, scenario("S5", "C3"), scenario("S6", "C5")]).score).toBe(1);
  });

  it("leaves the criteria judged untestable out of the score: 3 of the 4 others is 0.75, and 3 of 3 when the only gap is untestable", () => {
    expect(coverageOf(criteria, scenarios, { untestable: ["C5"] }).score).toBeCloseTo(0.75, 10);
    expect(coverageOf(criteria, [...scenarios, scenario("S5", "C3")], { untestable: ["C5"] }).score).toBe(1);
    // An untestable criterion that has a scenario leaves both sides of the fraction.
    expect(coverageOf(criteria, [...scenarios, scenario("S6", "C5")], { untestable: ["C5"] }).score).toBeCloseTo(0.75, 10);
    expect(coverageOf(criteria, [], { untestable: criteria.map((c) => c.id) }).score).toBe(1);
  });

  it("keeps an untestable criterion's gap on the list: the machine says what is missing, the score says how much matters", () => {
    expect(coverageOf(criteria, scenarios, { untestable: ["C5"] })).toMatchObject({ gaps: ["C3", "C5"], untestable: ["C5"] });
  });

  it("matches a v1 case (no ref) by the criterion's text, and a ref wins over the text", () => {
    const v1 = [scenario("S1", null, undefined, { type: undefined, criterion: "Cart totals add up" }), scenario("S2", "C4", "happy", { criterion: "Cart totals add up" })];
    const { per } = coverageOf(criteria, v1);
    expect(per[0]).toMatchObject({ scenarios: ["S1"], types: ["happy"] });
    expect(per[3]).toMatchObject({ scenarios: ["S2"] });
    expect(per[0]!.scenarios).not.toContain("S2");
  });

  it("scores an empty list of criteria as covered", () => {
    expect(coverageOf([], scenarios)).toMatchObject({ gaps: [], thin: [], score: 1 });
  });

  it("takes another reading of 'names a limit or an error' when given one", () => {
    expect(coverageOf(criteria, scenarios, { expectsEdge: () => false }).thin).toEqual([]);
    expect(coverageOf(criteria, scenarios, { expectsEdge: (c) => c.id === "C4" }).thin).toEqual(["C4"]);
  });
});

describe("namesLimitOrError", () => {
  it.each([
    ["The account locks after five failed logins", true],
    ["A bad password shows an error", true],
    ["An expired coupon is refused", true],
    ["At most three items per order", true],
    ["An empty cart shows the empty state", true],
    ["The cart shows the discounted total", false],
    ["The page has a title", false],
    ["A selected row stays selected", false],
  ])("%s -> %s", (text, expected) => {
    expect(namesLimitOrError(text)).toBe(expected);
  });
});
