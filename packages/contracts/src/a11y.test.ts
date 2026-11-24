import { describe, expect, it } from "vitest";

import { A11yAuditAnswer, A11yFinding, WCAG_LEVEL_OF } from "./a11y.ts";

const axe = { criterion: "1.4.3", level: "AA", source: "axe", rule: "color-contrast", impact: "serious", page: "/checkout", state: "default", selector: "button.pay", summary: "2.9:1 on the pay button", evidence: ["checkout-default.png", "axe-checkout-default.json"], fix: "darken the label to #1A1A1A", confidence: 1 };
const judged = { ...axe, criterion: "2.1.2", level: "A", source: "judged", rule: null, impact: null, selector: "div.modal", summary: "Tab never leaves the modal" };

describe("A11yFinding", () => {
  it("takes an axe finding and a judged one", () => {
    expect(A11yFinding.parse(axe).rule).toBe("color-contrast");
    expect(A11yFinding.parse(judged).rule).toBeNull();
  });
  it("refuses an axe finding without its rule and impact, and a judged one that names a rule", () => {
    expect(A11yFinding.safeParse({ ...axe, rule: null }).success).toBe(false);
    expect(A11yFinding.safeParse({ ...axe, impact: null }).success).toBe(false);
    expect(A11yFinding.safeParse({ ...judged, rule: "focus-trap" }).success).toBe(false);
  });
  it("refuses a criterion that is not a WCAG success criterion number", () => {
    expect(A11yFinding.safeParse({ ...axe, criterion: "contrast" }).success).toBe(false);
  });
});

describe("A11yAuditAnswer", () => {
  it("takes the pages and states audited and up to forty findings", () => {
    const answer = A11yAuditAnswer.parse({ summary: "one blocker", pages: [{ page: "/checkout", states: ["default", "focus"], axe: "ran" }], findings: [axe, judged] });
    expect(answer.findings).toHaveLength(2);
    expect(A11yAuditAnswer.safeParse({ summary: "x", pages: [], findings: Array(41).fill(axe) }).success).toBe(false);
  });
});

describe("WCAG_LEVEL_OF", () => {
  it("names the level of each WCAG 2.2 success criterion", () => {
    expect(WCAG_LEVEL_OF["2.1.2"]).toBe("A");
    expect(WCAG_LEVEL_OF["1.4.3"]).toBe("AA");
    expect(WCAG_LEVEL_OF["2.4.11"]).toBe("AA");
    expect(WCAG_LEVEL_OF["1.4.6"]).toBe("AAA");
  });
});
