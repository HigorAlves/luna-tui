import { describe, expect, it } from "vitest";

import { PlanAnswer, TestDesignAnswer } from "./packs.ts";
import { Plan, PlanStep, Scenario, criteriaOf, planOf, reviseCriteria, scenarioOf, scenarioText, scenariosOfAnswer, stepOf, stepsOfAnswer } from "./plan.ts";
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

  describe("the planner's v2.2 answer", () => {
    const answer = {
      kind: "done",
      summary: "s",
      brief: "Cap coupons",
      criteria: ["One use per cart"],
      steps: [
        { description: "Cap a coupon at one use", files: ["src/cart.ts", { path: "src/coupon-cap.ts", new: true }, { path: "src/cart.ts", new: false }], done_when: ["a second use is rejected", "One use per cart"], est_loc: 40 },
        { description: "Show the cap in the UI", files: [{ path: "src/ui/cart.tsx" }], done_when: ["the UI says so"], est_loc: 20, title: "UI" },
      ],
      outOfScope: ["refunds"],
      rollback: "revert the commit",
      migration: "none",
      flags: ["coupons_cap"],
    };

    it("accepts steps with a description, files (a path, or a path declared new), done_when and est_loc, beside everything a v1 answer had", () => {
      expect(PlanAnswer.safeParse(answer).success).toBe(true);
      expect(PlanAnswer.safeParse({ ...answer, steps: [{ description: "d", files: [], done_when: [], est_loc: -1.5 }] }).success).toBe(false);
      // A v1 answer, slices only, still parses.
      expect(PlanAnswer.safeParse({ kind: "done", summary: "s", slices: [{ title: "t", est_loc: 5, touchpoints: ["a.ts"], acceptance: ["ok"] }] }).success).toBe(true);
    });

    it("reads each step as a plan step and as the slice Build and the scope check read: files are the touchpoints, a new file is declared once", () => {
      const { steps, slices } = stepsOfAnswer(PlanAnswer.parse(answer).steps!);
      expect(steps[0]).toEqual({ title: "Cap a coupon at one use", description: "Cap a coupon at one use", est_loc: 40, files: ["src/cart.ts", "src/coupon-cap.ts"], new_files: ["src/coupon-cap.ts"], done_when: ["a second use is rejected", "One use per cart"], touchpoints: ["src/cart.ts", "src/coupon-cap.ts"], acceptance: ["a second use is rejected", "One use per cart"] });
      expect(steps[1]).toMatchObject({ title: "UI", description: "Show the cap in the UI", files: ["src/ui/cart.tsx"], new_files: [] });
      expect(slices[0]).toEqual({ title: "Cap a coupon at one use", est_loc: 40, touchpoints: ["src/cart.ts", "src/coupon-cap.ts"], acceptance: ["a second use is rejected", "One use per cart"] });
      expect(Slice.safeParse(slices[1]).success).toBe(true);
      expect(PlanStep.safeParse(steps[0]).success).toBe(true);
    });

    it("builds the Plan with ids by position, the version it is given, and migration and flags", () => {
      const parsed = PlanAnswer.parse(answer);
      const { steps } = stepsOfAnswer(parsed.steps!);
      const plan = planOf({ brief: parsed.brief, criteria: parsed.criteria, slices: steps, rollback: parsed.rollback, outOfScope: parsed.outOfScope, migration: parsed.migration, flags: parsed.flags, version: 3 });
      expect(plan).toMatchObject({ goal: "Cap coupons", version: 3, out_of_scope: ["refunds"], migration: "none", flags: ["coupons_cap"], acceptance_criteria: [{ id: "C1", text: "One use per cart" }] });
      expect(plan.steps.map((s) => s.id)).toEqual(["P1", "P2"]);
      expect(plan.steps[0]!.new_files).toEqual(["src/coupon-cap.ts"]);
      expect(planOf({ brief: "g" }).version).toBe(2);
    });

    it("keeps a criterion's id when a person edits the list: the same text keeps it, a new text takes the next free one", () => {
      const before = criteriaOf(["a", "b", "c"]);
      expect(reviseCriteria(before, ["c", "new", "a"])).toEqual([{ id: "C3", text: "c" }, { id: "C4", text: "new" }, { id: "C1", text: "a" }]);
      expect(reviseCriteria([], ["x"])).toEqual([{ id: "C1", text: "x" }]);
    });
  });

  describe("the designer's v2.2 answer", () => {
    const criteria = criteriaOf(["A coupon applies once", "An expired coupon is refused"]);
    const answer = {
      kind: "done",
      summary: "s",
      scenarios: [
        { criterion_ref: "C1", type: "happy", given: "a cart with one coupon", when: "the coupon is applied twice", then: "the discount counts once", data_needs: ["a coupon fixture"], layer: "unit" },
        { criterion_ref: "C2", type: "failure", given: "an expired coupon", when: "it is applied", then: "the cart shows the expiry error", layer: "integration" },
        { criterion_ref: "C9", type: "edge", given: "x", when: "y", then: "the discount counts once", layer: "e2e" },
      ],
    };

    it("accepts scenarios with a criterion ref, a type, given/when/then and a layer, and still accepts v1 cases", () => {
      expect(TestDesignAnswer.safeParse(answer).success).toBe(true);
      expect(TestDesignAnswer.safeParse({ kind: "done", summary: "s", cases: [{ title: "t", criterion: "c", approach: "run it" }] }).success).toBe(true);
      expect(TestDesignAnswer.safeParse({ ...answer, scenarios: [{ ...answer.scenarios[0], type: "sunny" }] }).success).toBe(false);
      expect(TestDesignAnswer.safeParse({ ...answer, scenarios: [{ ...answer.scenarios[0], layer: "manual" }] }).success).toBe(false);
    });

    it("turns them into scenarios the later stages key on: S ids, the criterion's text, a title from `then`, the round as version", () => {
      const scenarios = scenariosOfAnswer(TestDesignAnswer.parse(answer).scenarios!, criteria, 2);
      expect(scenarios[0]).toEqual({
        id: "S1", title: "the discount counts once", criterion: "A coupon applies once", criterion_ref: "C1", type: "happy",
        given: "a cart with one coupon", when: "the coupon is applied twice", then: "the discount counts once",
        approach: "Given a cart with one coupon, when the coupon is applied twice, then the discount counts once (unit)", data_needs: ["a coupon fixture"], layer: "unit", version: 2,
      });
      expect(scenarios[1]).toMatchObject({ id: "S2", criterion: "An expired coupon is refused", type: "failure", data_needs: [] });
      // An unknown criterion ref ties to nothing; a title another scenario already has is told apart by its id.
      expect(scenarios[2]).toMatchObject({ id: "S3", criterion: null, criterion_ref: null, title: "the discount counts once (S3)" });
      expect(scenarios.every((s) => Scenario.safeParse(s).success)).toBe(true);
    });

    it("says a scenario as given/when/then, or by its approach when it has none (a v1 case)", () => {
      expect(scenarioText({ approach: "a", given: "g", when: "w", then: "th" })).toBe("given g, when w, then th");
      expect(scenarioText({ approach: "run the unit test" })).toBe("run the unit test");
      expect(scenarioText({ approach: "a", given: "g", when: null, then: null })).toBe("a");
    });
  });
});
