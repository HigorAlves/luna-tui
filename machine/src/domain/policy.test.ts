import { describe, expect, it } from "vitest";

import { DEFAULT_POLICY, parsePolicy } from "./policy.ts";

const file = (front: string) => `---\n${front}\n---\n\n# How this repo wants the pipeline to behave\n`;

describe("parsePolicy", () => {
  it("reads every key from the front matter and leaves the rest at its default", () => {
    const policy = parsePolicy(
      file("qa: none\nmonthly_budget_usd: 40\nauto_approve_plan_minutes: 15\nmax_concurrent: 1\nholdout_cases: true"),
    );
    expect(policy).toEqual({
      qa: "none",
      monthlyBudgetUsd: 40,
      autoApprovePlanMinutes: 15,
      maxConcurrent: 1,
      holdoutCases: true,
    });
  });

  it("is all defaults for an empty file, no front matter, or prose only", () => {
    expect(parsePolicy("")).toEqual(DEFAULT_POLICY);
    expect(parsePolicy("# Just notes\n")).toEqual(DEFAULT_POLICY);
    expect(parsePolicy(file(""))).toEqual(DEFAULT_POLICY);
    expect(DEFAULT_POLICY).toEqual({
      qa: "web",
      monthlyBudgetUsd: null,
      autoApprovePlanMinutes: null,
      maxConcurrent: null,
      holdoutCases: false,
    });
  });

  it("ignores comments, blank lines and keys it does not know", () => {
    expect(parsePolicy(file("# a comment\n\nqa: none\nsomething_else: 3"))).toEqual({ ...DEFAULT_POLICY, qa: "none" });
  });

  it("refuses a value it cannot read, naming the key", () => {
    expect(() => parsePolicy(file("qa: mobile"))).toThrow(/qa must be web or none/);
    expect(() => parsePolicy(file("monthly_budget_usd: lots"))).toThrow(/monthly_budget_usd must be a positive amount/);
    expect(() => parsePolicy(file("auto_approve_plan_minutes: 0"))).toThrow(/auto_approve_plan_minutes must be a positive integer/);
    expect(() => parsePolicy(file("max_concurrent: -1"))).toThrow(/max_concurrent must be a positive integer/);
    expect(() => parsePolicy(file("holdout_cases: maybe"))).toThrow(/holdout_cases must be true or false/);
    expect(() => parsePolicy(file("qa none"))).toThrow(/line 2: expected key: value/);
  });
});
