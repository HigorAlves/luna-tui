import { describe, expect, it } from "vitest";

import { buildEntryOf } from "./build-entry.ts";
import type { ApprovalRow } from "./task.ts";

const approval = (requested: Record<string, unknown>): ApprovalRow =>
  ({ id: "a", taskId: "t1", kind: "awaiting_approval", requested, decision: "approved", reason: null, response: null, createdAt: new Date(0), decidedAt: new Date(0) }) as ApprovalRow;

const plan = {
  goal: "Export the cart",
  steps: [{ id: "P1", title: "Button", description: "Button", est_loc: 40, touchpoints: ["web/cart.tsx"], acceptance: ["C1"], files: ["web/cart.tsx"], done_when: ["C1"] }],
  acceptance_criteria: [{ id: "C1", text: "Has a button" }],
  out_of_scope: [],
  assumptions: [],
  rollback: "revert",
  version: 2,
};
const cases = [{ id: "S1", title: "t", criterion: "Has a button", criterion_ref: "C1", approach: "a" }];
const map = { components: ["web"], files: [{ path: "web/cart.tsx", role: "change" }], entry_points: [], owners: [], confidence: 0.8 };
const record = { goal: "Export the cart" };

describe("the entry contract read from the approved gate", () => {
  it("passes a v2.2 gate with plan, cases, map, risk and record", () => {
    const gate = approval({ plan, cases, map, risk: { level: "low" } });
    expect(buildEntryOf([gate], record)).toMatchObject({ ok: true, readAs: "v2" });
  });

  it("names what is missing and leaves out a criterion the gate excused as untestable", () => {
    const gate = approval({ plan, cases: [], map, risk: { level: "low" }, coverageReport: { untestable: ["C1"] } });
    expect(buildEntryOf([gate], record).ok).toBe(true);
    expect(buildEntryOf([approval({ plan, cases: [], map, risk: { level: "low" } })], record).missing.join(" ")).toMatch(/C1/);
    expect(buildEntryOf([approval({ plan, cases, risk: { level: "low" } })], record).missing.join(" ")).toMatch(/map/);
    expect(buildEntryOf([approval({ plan, cases, map, risk: { level: "low" }, mapNote: "no code graph" })], record).ok).toBe(true);
  });

  it("reads a gate approved before v2.2 (no plan object, cases without ids) as v1", () => {
    const gate = approval({ brief: "b", criteria: ["c"], slices: [{ title: "s", est_loc: 1, touchpoints: ["a.ts"], acceptance: ["x"] }], cases: [{ title: "t", criterion: "c", approach: "a" }] });
    expect(buildEntryOf([gate], null)).toMatchObject({ ok: true, readAs: "v1" });
  });

  it("names no approved plan when there is no approval", () => {
    expect(buildEntryOf([], record).missing.join(" ")).toMatch(/plan/);
  });
});
