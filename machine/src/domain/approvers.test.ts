import { describe, expect, it } from "vitest";

import { applyRiskOverride, approvalRule, outsideSatisfied, sameName } from "./approvers.ts";

const config = { low: 1, medium: 1, high: 2, outside_owning_team: true };

describe("approvalRule", () => {
  it("wants the configured number of names for the level: one for low and medium, two for high", () => {
    expect(approvalRule("low", config, ["@marta"])).toMatchObject({ needed: 1, outside: "off" });
    expect(approvalRule("medium", config, ["@marta"])).toMatchObject({ needed: 1, outside: "off" });
    expect(approvalRule("high", config, ["@marta"])).toMatchObject({ needed: 2, outside: "required" });
    expect(approvalRule("none", config, []).needed).toBe(1);
    expect(approvalRule("high", { ...config, high: 3 }, ["@marta"]).needed).toBe(3);
  });

  it("asks for an approver from outside the owners only when high, configured and owners are known; without owners it skips the condition and says so", () => {
    expect(approvalRule("high", { ...config, outside_owning_team: false }, ["@marta"]).outside).toBe("off");
    const skipped = approvalRule("high", config, []);
    expect(skipped.outside).toBe("skipped");
    expect(skipped.text).toMatch(/no owners were found.*skipped/i);
  });

  it("says in the gate's words that the outside condition is an attestation the machine does not check", () => {
    const { text } = approvalRule("high", config, ["@marta", "@org/payments"]);
    expect(text).toMatch(/2 approvers/);
    expect(text).toMatch(/at least one .*not among the code map's owners/i);
    expect(text).toMatch(/attestation/i);
    expect(approvalRule("low", config, []).text).toBe("Needs 1 approver.");
  });
});

describe("outsideSatisfied", () => {
  it("is true when at least one name is not among the owners, comparing names the way the approvers rule does", () => {
    expect(outsideSatisfied(["ana", "bo"], ["@ana", "@bo"])).toBe(false);
    expect(outsideSatisfied(["Ana ", "carla"], ["@ana", "@bo"])).toBe(true);
    expect(outsideSatisfied(["ana"], [])).toBe(true);
  });

  it("reads an owner `@org/team` as the team's name and an email as itself", () => {
    expect(outsideSatisfied(["org/payments"], ["@org/payments"])).toBe(false);
    expect(outsideSatisfied(["ana@corp.com"], ["ana@corp.com"])).toBe(false);
    expect(outsideSatisfied(["ana@corp.com", "bo"], ["ana@corp.com"])).toBe(true);
  });
});

describe("sameName", () => {
  it("compares NFKC-normalised, trimmed and lower-cased", () => {
    expect(sameName("Ana", " ana ")).toBe(true);
    expect(sameName("ａｎａ", "ana")).toBe(true);
    expect(sameName("ana", "bo")).toBe(false);
  });
});

describe("applyRiskOverride: the machine's level is a floor", () => {
  const machine = { level: "medium" as const, product: 6, scores: { blast_radius: 1 } };

  it("applies a raised level at once and keeps the machine's own", () => {
    const { risk, override } = applyRiskOverride(machine, { level: "high", reason: "touches billing" });
    expect(risk).toMatchObject({ level: "high", machine: "medium", product: 6 });
    expect(override).toEqual({ level: "high", reason: "touches billing", applied: true });
  });

  it("keeps a lowered level with its reason, shown, while the level everything reads stays the machine's", () => {
    const { risk, override } = applyRiskOverride(machine, { level: "low", reason: "behind a flag" });
    expect(risk).toMatchObject({ level: "medium", machine: "medium" });
    expect(override).toEqual({ level: "low", reason: "behind a flag", applied: false });
  });

  it("treats the same level as applied, reads the machine's level from an earlier override, and never lowers below it twice", () => {
    expect(applyRiskOverride(machine, { level: "medium", reason: "agreed" }).override.applied).toBe(true);
    const first = applyRiskOverride(machine, { level: "high", reason: "r" });
    // The risk now says high; the machine's grade is still medium, so a later lower edit falls to the floor, not to the earlier raise.
    expect(applyRiskOverride(first.risk, { level: "low", reason: "undo" }).risk).toMatchObject({ level: "medium", machine: "medium" });
  });
});
