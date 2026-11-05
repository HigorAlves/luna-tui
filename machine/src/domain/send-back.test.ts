import { findingId } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import { evidenceFindings, scenarioFindings } from "./send-back.ts";

describe("what a card sent back from the browser run carries", () => {
  const rows = [
    { text: "A reader can export the report", criterion: "C1", result: "fail", evidence: ["export-1.png", "console.log"] },
    { text: "The export is named after the report", result: "pass", evidence: [] },
    { text: "Large reports do not time out", result: "partial", evidence: [] },
  ];

  it("is one finding per scenario that did not pass, with what was expected, what was seen, the artifacts' names and the judged cause", () => {
    const found = scenarioFindings(rows, "the page showed a 500", "product_bug");
    expect(found).toHaveLength(2);
    expect(found[0]).toMatchObject({ severity: "blocker", category: "correctness", criterion_ref: "C1", title: "scenario failed: A reader can export the report" });
    expect(found[0]!.body).toBe("expected: A reader can export the report\nseen: the page showed a 500\nartifacts: export-1.png, console.log\ncause: product_bug");
    expect(found[0]!.id).toBe(findingId(found[0]!));
    expect(found[1]).toMatchObject({ title: "scenario partly done: Large reports do not time out" });
  });

  it("flattens and caps every text, and names no path", () => {
    const [one] = scenarioFindings([{ text: `<b>x</b>\n${"y".repeat(900)}`, result: "fail", evidence: ["../../etc/passwd", "ok.png"] }], "seen\n@bob #12", null);
    expect(one!.title).not.toContain("<b>");
    expect(one!.title.length).toBeLessThanOrEqual(220);
    expect(one!.body).not.toContain("\n@bob");
    expect(one!.body).toContain("artifacts: ok.png");
    expect(one!.body).not.toContain("passwd");
    expect(one!.body).not.toMatch(/cause:/);
  });

  it("makes one finding of what Evidence is missing", () => {
    const [one] = evidenceFindings("no manifest.json from the e2e run; the criteria are not shown working");
    expect(one).toMatchObject({ severity: "blocker", title: "Evidence is missing", confidence: 1 });
    expect(one!.body).toContain("no manifest.json");
  });
});
