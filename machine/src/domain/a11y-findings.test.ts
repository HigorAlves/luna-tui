import { type A11yFinding, mergeDuplicateFindings } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import { a11yFindings } from "./a11y-findings.ts";

const axe = (impact: "critical" | "serious" | "moderate" | "minor", criterion = "1.4.3"): A11yFinding => ({ criterion, level: "AA", source: "axe", rule: "color-contrast", impact, page: "/checkout", state: "default", selector: "button.pay", summary: "low contrast", evidence: ["axe-checkout-default.json"], fix: null, confidence: 1 });
const judged: A11yFinding = { criterion: "2.1.2", level: "A", source: "judged", rule: null, impact: null, page: "/checkout", state: "modal open", selector: "div.modal", summary: "Tab never leaves the modal", evidence: ["trap.png"], fix: "return focus on Escape", confidence: 0.9 };
const gate = { level: "AA" as const, mode: "gate" as const };

describe("a11yFindings", () => {
  it("makes axe critical and serious, and judged failures, blockers; moderate and minor should_fix", () => {
    const { findings } = a11yFindings([axe("critical"), axe("serious"), axe("moderate"), axe("minor"), judged], gate);
    expect(findings.map((f) => f.severity)).toEqual(["blocker", "blocker", "should_fix", "should_fix", "blocker"]);
    for (const f of findings) expect(f).toMatchObject({ category: "accessibility", path: "/checkout", line: 0 });
  });
  it("keeps an AAA criterion as a nit under AA, and counts it at AAA", () => {
    expect(a11yFindings([axe("serious", "1.4.6")], gate).findings[0]!.severity).toBe("nit");
    expect(a11yFindings([axe("serious", "1.4.6")], { level: "AAA", mode: "gate" }).findings[0]!.severity).toBe("blocker");
  });
  it("makes every finding should_fix in advisory mode, and an AAA criterion under AA stays a nit", () => {
    expect(a11yFindings([axe("critical"), judged], { level: "AA", mode: "advisory" }).findings.map((f) => f.severity)).toEqual(["should_fix", "should_fix"]);
    expect(a11yFindings([axe("critical", "1.4.6")], { level: "AA", mode: "advisory" }).findings[0]!.severity).toBe("nit");
  });
  it("reads the level from WCAG, not from the auditor", () => {
    const lying = { ...axe("serious", "1.4.6"), level: "AA" as const };
    expect(a11yFindings([lying], gate).findings[0]!.severity).toBe("nit");
  });
  it("keeps a criterion WCAG does not have at should_fix, with a note", () => {
    const out = a11yFindings([axe("critical", "9.9.9")], gate);
    expect(out.findings[0]!.severity).toBe("should_fix");
    expect(out.notes).toEqual(["9.9.9 is not a WCAG 2.2 success criterion: kept as should_fix"]);
  });
  it("names the criterion and the selector in the title and gives a stable id, so a repeat merges", () => {
    const [a] = a11yFindings([axe("serious")], gate).findings;
    expect(a!.title).toBe("WCAG 1.4.3 (AA): button.pay on /checkout");
    expect(a!.body).toContain("state default");
    expect(a!.id).toMatch(/^F[0-9a-f]{8}$/);
    expect(mergeDuplicateFindings([...a11yFindings([axe("serious")], gate).findings, ...a11yFindings([axe("serious")], gate).findings])).toHaveLength(1);
  });
});
