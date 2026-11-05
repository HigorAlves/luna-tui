import { describe, expect, it } from "vitest";

import { entryContract } from "./entry-contract.ts";

// What Plan hands to Build, as the plan gate stores it: the diagram's entry contract for panel 4.
const plan = {
  goal: "Export the cart as CSV",
  steps: [{ id: "P1", title: "Add the button", description: "Add the button", est_loc: 40, touchpoints: ["web/cart.tsx"], acceptance: ["C1"], files: ["web/cart.tsx"], new_files: [], done_when: ["C1"] }],
  acceptance_criteria: [
    { id: "C1", text: "The cart page has an Export button" },
    { id: "C2", text: "The file lists each line with its price" },
  ],
  out_of_scope: [],
  assumptions: [],
  rollback: "Revert the merge commit.",
  version: 2,
};
const scenario = (id: string, ref: string) => ({ id, title: `proves ${ref}`, criterion: null, approach: "", criterion_ref: ref, type: "happy" as const, given: "a cart with two lines", when: "Export is clicked", then: "the file has two rows" });
const map = { components: ["web"], files: [{ path: "web/cart.tsx", role: "change" as const }], entry_points: [], owners: [], confidence: 0.8 };
const complete = { plan, scenarios: [scenario("S1", "C1"), scenario("S2", "C2")], untestable: [] as string[], map, mapNote: null, risk: { level: "low" as const }, record: { goal: "Export the cart as CSV" } };

describe("the entry contract of Build", () => {
  it("passes a plan with a version, a scenario for every criterion, a map, a risk and a record", () => {
    expect(entryContract(complete)).toMatchObject({ ok: true, missing: [] });
  });

  it("names a criterion that no scenario proves, unless the gate excused it as untestable", () => {
    const one = { ...complete, scenarios: [scenario("S1", "C1")] };
    expect(entryContract(one)).toMatchObject({ ok: false, missing: [expect.stringMatching(/C2/)] });
    expect(entryContract({ ...one, untestable: ["C2"] })).toMatchObject({ ok: true });
  });

  it("names a missing plan, risk and record, and a map that is absent with no reason given", () => {
    expect(entryContract({ ...complete, plan: null }).missing.join(" ")).toMatch(/plan/);
    expect(entryContract({ ...complete, risk: null }).missing.join(" ")).toMatch(/risk/);
    expect(entryContract({ ...complete, record: null }).missing.join(" ")).toMatch(/record/);
    expect(entryContract({ ...complete, map: null }).missing.join(" ")).toMatch(/map/);
    expect(entryContract({ ...complete, map: null, mapNote: "the repository has no code graph" })).toMatchObject({ ok: true });
  });

  it("names a plan whose steps name no file: Build would have nothing planned to check its diff against", () => {
    const empty = { ...complete, plan: { ...plan, steps: [{ ...plan.steps[0]!, files: [], touchpoints: [] }] }, map: null, mapNote: "the repository has no code graph" };
    expect(entryContract(empty)).toMatchObject({ ok: false, missing: [expect.stringMatching(/file/)] });
  });
});
