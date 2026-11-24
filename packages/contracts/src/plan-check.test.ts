import { describe, expect, it } from "vitest";

import { planFacts } from "./plan-check.ts";
import { type Plan, type Scenario, planOf } from "./plan.ts";
import type { CodeMapAnswer } from "./stage.ts";

const map = (files: Array<[string, "change" | "read" | "test"]>): CodeMapAnswer => ({ components: [], files: files.map(([path, role]) => ({ path, role })), entry_points: [], owners: [], confidence: 0.8 });
const theMap = map([["src/cart.ts", "change"], ["src/coupon.ts", "read"], ["src/cart.test.ts", "test"]]);

const plan = (over: Partial<Parameters<typeof planOf>[0]> = {}): Plan =>
  planOf({
    brief: "Cap coupons",
    criteria: ["A coupon applies once", "An expired coupon is refused"],
    slices: [
      { title: "cap", description: "Cap a coupon", est_loc: 30, touchpoints: ["src/cart.ts", "src/cap.ts"], acceptance: ["a second use is rejected: A coupon applies once"], files: ["src/cart.ts", "src/cap.ts"], new_files: ["src/cap.ts"], done_when: ["a second use is rejected: A coupon applies once"] },
      { title: "expiry", description: "Refuse expired", est_loc: 20, touchpoints: ["src/coupon.ts"], acceptance: ["C2 holds"], files: ["src/coupon.ts"], done_when: ["C2 holds"] },
    ],
    rollback: "revert the commit",
    ...over,
  });

const scenario = (ref: string | null): Scenario => ({ id: "S1", title: "t", criterion: null, criterion_ref: ref, approach: "a" });

describe("planFacts", () => {
  it("finds nothing wrong with a plan whose criteria are named, files are mapped or new, and rollback is there", () => {
    expect(planFacts(plan(), [scenario("C1"), scenario("C2")], theMap)).toEqual({ ok: true, issues: [] });
  });

  it("names a criterion no step's done_when mentions, by its text or by its id", () => {
    const facts = planFacts(plan({ criteria: ["A coupon applies once", "An expired coupon is refused", "The page has a title"] }), [], theMap);
    expect(facts.issues).toEqual(["C3 appears in no step's done_when: The page has a title"]);
    // The text matches whatever its case and spacing.
    const spaced = planFacts(plan({ criteria: ["A  COUPON applies once", "An expired coupon is refused"] }), [], theMap);
    expect(spaced.issues).toEqual([]);
  });

  it("names a step's file that is neither in the code map nor declared new", () => {
    const outside = plan({ slices: [{ title: "x", description: "x", est_loc: 5, touchpoints: ["src/other.ts"], acceptance: ["C1 C2"], files: ["src/other.ts"], new_files: [], done_when: ["C1 C2"] }] });
    expect(planFacts(outside, [], theMap).issues).toEqual(["P1 touches src/other.ts, which the code map does not name and the step does not declare new"]);
    // A read or a test file of the map is in the map; a declared new file is allowed.
    const fine = plan({ slices: [{ title: "x", description: "x", est_loc: 5, touchpoints: ["src/coupon.ts", "src/cart.test.ts", "src/new.ts"], acceptance: ["C1 C2"], files: ["./src/coupon.ts", "src/cart.test.ts", "src/new.ts"], new_files: ["src/new.ts"], done_when: ["C1 C2"] }] });
    expect(planFacts(fine, [], theMap).issues).toEqual([]);
  });

  it("does not check files against a map there is not", () => {
    const outside = plan({ slices: [{ title: "x", description: "x", est_loc: 5, touchpoints: ["src/other.ts"], acceptance: ["C1 C2"], files: ["src/other.ts"], done_when: ["C1 C2"] }] });
    expect(planFacts(outside, [], null).issues).toEqual([]);
  });

  it("fails a step that names no file: a plan whose steps name none cannot reach Build with nothing planned", () => {
    const none = plan({ slices: [{ title: "x", description: "x", est_loc: 5, touchpoints: [], acceptance: ["C1 C2"], files: [], done_when: ["C1 C2"] }] });
    expect(planFacts(none, [], theMap).issues).toEqual(["P1 names no file"]);
    expect(planFacts(none, [], null).issues).toEqual(["P1 names no file"]);
    // A step whose every path was dropped as not plain also names no file, and says which were dropped.
    const dropped = plan({ slices: [{ title: "x", description: "x", est_loc: 5, touchpoints: [], acceptance: ["C1 C2"], files: [], dropped_files: ["**"], done_when: ["C1 C2"] }] });
    expect(planFacts(dropped, [], theMap).issues).toEqual(["P1 named a path that is not a plain repo-relative path: **", "P1 names no file"]);
  });

  it("names the paths a map or a step had that were not plain repo paths", () => {
    const withDropped = { ...theMap, dropped: ["/etc/passwd", "src/*"] };
    expect(planFacts(plan(), [], withDropped).issues).toEqual(["the code map named a path that is not a plain repo-relative path: /etc/passwd", "the code map named a path that is not a plain repo-relative path: src/*"]);
  });

  it("wants a rollback, and a blank one is none", () => {
    expect(planFacts(plan({ rollback: "" }), [], theMap).issues).toEqual(["the plan has no rollback"]);
    expect(planFacts(plan({ rollback: "  \n " }), [], theMap).issues).toEqual(["the plan has no rollback"]);
  });

  it("names a scenario tied to a criterion the plan does not have", () => {
    expect(planFacts(plan(), [scenario("C9")], theMap).issues).toEqual(["scenario S1 is tied to C9, which is not a criterion of the plan"]);
    expect(planFacts(plan(), [scenario(null)], theMap).issues).toEqual([]);
  });

  it("lists every issue at once, in the order criteria, files, rollback, scenarios", () => {
    const bad = plan({ criteria: ["lonely"], rollback: "", slices: [{ title: "x", description: "x", est_loc: 5, touchpoints: ["z.ts"], acceptance: [], files: ["z.ts"], done_when: [] }] });
    const facts = planFacts(bad, [scenario("C4")], theMap);
    expect(facts.ok).toBe(false);
    expect(facts.issues.map((i) => i.split(" ")[0])).toEqual(["C1", "P1", "the", "scenario"]);
  });

  it("reads a plan from a v1 gate: steps from slices carry files and done_when, so the same facts hold", () => {
    const v1 = planOf({ brief: "b", criteria: ["no panic"], slices: [{ title: "guard", est_loc: 5, touchpoints: ["src/cart.ts"], acceptance: ["no panic on empty"] }], rollback: "revert" });
    expect(planFacts(v1, [], theMap)).toEqual({ ok: true, issues: [] });
  });
});
