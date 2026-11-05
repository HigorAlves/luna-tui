import { describe, expect, it } from "vitest";

import { type OwnersState, applyRiskOverride, approvalRule, outsideSatisfied, ownersStateOf, sameName } from "./approvers.ts";

const config = { low: 1, medium: 1, high: 2, outside_owning_team: true };

const known = (...owners: string[]): OwnersState => ({ state: "ok", owners });
const skipped: OwnersState = { state: "skipped" };

describe("ownersStateOf: the owners the rule reads come from CODEOWNERS only", () => {
  const rows = (...owners: string[][]) => owners.map((o, i) => ({ path: `f${i}`, owners: o }));

  it("is ok with the owners CODEOWNERS names for the files, each once", () => {
    expect(ownersStateOf({ owners: rows(["@ana"], ["@ana", "@org/pay"]), codeowners: true })).toEqual({ state: "ok", owners: ["@ana", "@org/pay"] });
  });

  it("is skipped only when the repo has no CODEOWNERS or no rule matches the files", () => {
    expect(ownersStateOf({ owners: [], codeowners: false })).toEqual({ state: "skipped" });
    expect(ownersStateOf({ owners: [], codeowners: true })).toEqual({ state: "skipped" });
  });

  it("is not checked when the lookup failed, there is no port or graph, or some paths could not be looked up", () => {
    expect(ownersStateOf(null)).toMatchObject({ state: "not_checked", reason: expect.stringMatching(/could not be read/) });
    expect(ownersStateOf("failed")).toMatchObject({ state: "not_checked" });
    expect(ownersStateOf({ owners: rows(["@ana"]), codeowners: true, dropped: 2 })).toMatchObject({ state: "not_checked", reason: expect.stringMatching(/2 paths/) });
  });
});

describe("approvalRule", () => {
  it("wants the configured number of names for the level: one for low and medium, two for high", () => {
    expect(approvalRule("low", config, known("@marta"))).toMatchObject({ needed: 1, outside: "off" });
    expect(approvalRule("medium", config, known("@marta"))).toMatchObject({ needed: 1, outside: "off" });
    expect(approvalRule("high", config, known("@marta"))).toMatchObject({ needed: 2, outside: "required" });
    expect(approvalRule("none", config, skipped).needed).toBe(1);
    expect(approvalRule("high", { ...config, high: 3 }, known("@marta")).needed).toBe(3);
  });

  it("asks for an approver from outside the owners only when high, configured and the owners are known; with no CODEOWNERS or no match it skips the condition and says so", () => {
    expect(approvalRule("high", { ...config, outside_owning_team: false }, known("@marta")).outside).toBe("off");
    const none = approvalRule("high", config, skipped);
    expect(none.outside).toBe("skipped");
    expect(none.text).toMatch(/no CODEOWNERS rule matches.*skipped/i);
  });

  it("says when the owners could not be checked that the condition is not enforced", () => {
    const rule = approvalRule("high", config, { state: "not_checked", reason: "the code owners could not be read" });
    expect(rule).toMatchObject({ needed: 2, outside: "not_checked" });
    expect(rule.text).toMatch(/could not be checked/i);
    expect(rule.text).toMatch(/not enforced/i);
  });

  it("says in the gate's words that the outside condition is an attestation the machine does not check", () => {
    const { text } = approvalRule("high", config, known("@marta", "@org/payments"));
    expect(text).toMatch(/2 approvers/);
    expect(text).toMatch(/at least one .*not among the code owners/i);
    expect(text).toMatch(/attestation/i);
    expect(approvalRule("low", config, skipped).text).toBe("Needs 1 approver.");
  });

  it("flattens and caps the owner strings it prints, and says a team handle's members are unknown to the machine", () => {
    const evil = `@x\n**bold** [click](https://evil.example) ${"z".repeat(200)}`;
    const { text } = approvalRule("high", config, known(evil, "@org/team"));
    expect(text).not.toMatch(/\n|\]\(/);
    expect(text.length).toBeLessThan(700);
    const teams = approvalRule("high", config, known("@org/a", "@org/b")).text;
    expect(teams).toMatch(/teams.*cannot tell whether a name is inside/i);
    expect(approvalRule("high", config, known("@ana", "@org/b")).text).not.toMatch(/cannot tell whether a name is inside/i);
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
