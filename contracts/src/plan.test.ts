import { describe, expect, it } from "vitest";

import { PlanAnswer } from "./packs.ts";
import { Plan, PlanStep, Scenario, criteriaOf, planOf, scenarioOf, stepOf } from "./plan.ts";
import { Slice, TestCase } from "./stage.ts";

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

  it("gives a case with no matching criterion a null ref, and a case with no criterion a null ref", () => {
    const criteria = criteriaOf(["a", "b"]);
    expect(scenarioOf({ title: "t", criterion: "zzz", approach: "x" }, 2, criteria)).toMatchObject({ id: "S3", criterion_ref: null, given: null, when: null, then: null, layer: null });
    expect(scenarioOf({ title: "t", criterion: null, approach: "x" }, 0, criteria).criterion_ref).toBeNull();
  });

  it("keeps ids stable for the same list, and lets a criteria list with ids pass through", () => {
    const list = ["x", "y", "z"];
    expect(criteriaOf(list)).toEqual(criteriaOf(list));
    expect(criteriaOf([{ id: "C9", text: "kept" }])).toEqual([{ id: "C9", text: "kept" }]);
  });

  it("passes a v2 scenario through and round-trips it", () => {
    const v2 = Scenario.parse({ id: "S4", criterion_ref: "C2", type: "edge", given: "g", when: "w", then: "t", data_needs: ["fixture"], layer: "e2e", version: 2, title: "x", criterion: "c", approach: "a" });
    expect(scenarioOf(v2, 0, [])).toBe(v2);
    expect(Scenario.parse(JSON.parse(JSON.stringify(v2)))).toEqual(v2);
  });

  it("exports TestCase as the same schema, and a v1 case list parses", () => {
    expect(TestCase).toBe(Scenario);
    const v1 = [{ title: "a", criterion: "c1", approach: "pnpm test" }, { title: "b", criterion: null, approach: "read" }];
    expect(v1.map((c) => TestCase.safeParse(c).success)).toEqual([true, true]);
  });

  it("reads a slice as a plan step: an id, files from touchpoints, done_when from acceptance", () => {
    const slice = Slice.parse({ title: "Add the route", est_loc: 80, touchpoints: ["src/a.ts", "src/b.ts"], acceptance: ["returns 200"] });
    const step = stepOf(slice, 1);
    expect(step).toMatchObject({ id: "P2", description: "Add the route", files: ["src/a.ts", "src/b.ts"], done_when: ["returns 200"] });
    expect(PlanStep.safeParse(step).success).toBe(true);
    expect(PlanStep.safeParse(slice).success).toBe(true);
    expect(stepOf(step, 5)).toEqual(step);
  });

  it("builds a Plan from a v1 plan gate payload", () => {
    const payload = PlanAnswer.parse({
      kind: "done",
      summary: "s",
      brief: "Cap coupons",
      criteria: ["One use per cart"],
      assumptions: ["carts are per user"],
      slices: [{ title: "Cap", est_loc: 40, touchpoints: ["src/cart.ts"], acceptance: ["second use rejected"] }],
      rollback: "revert the commit",
    });
    const plan = planOf({ brief: payload.brief, criteria: payload.criteria, assumptions: payload.assumptions, slices: payload.slices, rollback: payload.rollback });
    expect(plan).toEqual({
      goal: "Cap coupons",
      steps: [{ title: "Cap", est_loc: 40, touchpoints: ["src/cart.ts"], acceptance: ["second use rejected"], id: "P1", description: "Cap", files: ["src/cart.ts"], done_when: ["second use rejected"] }],
      acceptance_criteria: [{ id: "C1", text: "One use per cart" }],
      out_of_scope: [],
      assumptions: ["carts are per user"],
      rollback: "revert the commit",
      version: 2,
    });
    expect(Plan.parse(JSON.parse(JSON.stringify(plan)))).toEqual(plan);
  });

  it("carries migration and flags when given, and PlanAnswer accepts them", () => {
    const plan = planOf({ brief: "g", migration: "add column", flags: ["coupons_v2"], outOfScope: ["refunds"] });
    expect(plan).toMatchObject({ migration: "add column", flags: ["coupons_v2"], out_of_scope: ["refunds"] });
    expect(PlanAnswer.safeParse({ kind: "done", summary: "s", outOfScope: ["x"], migration: "m", flags: ["f"] }).success).toBe(true);
  });
});
