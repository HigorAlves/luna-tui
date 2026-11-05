import { describe, expect, it } from "vitest";

import { Scenario, criteriaOf, scenarioOf } from "./plan.ts";

describe("the v2.2 plan contracts", () => {
  it("reads a case written before v2.2 as a scenario: an id from its place, the criterion by its id, the approach kept", () => {
    const criteria = criteriaOf(["A coupon applied twice counts once", "The cart shows the discounted total"]);
    expect(criteria).toEqual([
      { id: "C1", text: "A coupon applied twice counts once" },
      { id: "C2", text: "The cart shows the discounted total" },
    ]);
    const scenario = scenarioOf({ title: "second click is a no-op", criterion: "A coupon applied twice counts once", approach: "pnpm test cart" }, 0, criteria);
    expect(scenario).toMatchObject({ id: "S1", criterion_ref: "C1", type: "happy", title: "second click is a no-op", approach: "pnpm test cart" });
    expect(Scenario.safeParse(scenario).success).toBe(true);
    // A case stored before this wave is still a valid scenario on the wire.
    expect(Scenario.safeParse({ title: "t", criterion: null, approach: "a" }).success).toBe(true);
  });
});
