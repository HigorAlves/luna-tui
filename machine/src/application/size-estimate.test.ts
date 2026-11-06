import { describe, expect, it } from "vitest";

import { FACTORY_DEFAULTS, SizeContext, sizeLimits } from "@hardness/contracts";

import { sizeAssessment, sizeContextOf, similarCards } from "./size-estimate.ts";

const limits = sizeLimits(FACTORY_DEFAULTS.size);
const now = new Date("2026-11-05T12:00:00Z");
const closed = (id: string, title: string, added: number | null, removed: number | null, repo = "/r") => ({ id, kind: "closed" as const, title, text: "", repo, closedAt: new Date("2026-11-01T00:00:00Z"), diffAdded: added, diffRemoved: removed });

describe("similarCards", () => {
  const card = { title: "Export reports as CSV", text: "csv export of a report", repo: "/r" };

  it("keeps only closed cards of the same repository with a counted diff, nearest first, five at most", () => {
    const cards = [
      closed("a", "Export reports as CSV file", 300, 20),
      closed("b", "Export reports to CSV with no count", null, null),
      closed("c", "Export reports as CSV elsewhere", 100, 0, "/other"),
      { ...closed("d", "Export reports as CSV again", 50, 5), kind: "open" as const },
      ...[1, 2, 3, 4, 5, 6].map((n) => closed(`n${n}`, `Export reports csv number ${n}`, n * 10, 1)),
    ];
    const found = similarCards(card, cards, { now, lookbackDays: 90 });
    expect(found.length).toBeLessThanOrEqual(5);
    expect(found[0]).toEqual({ title: "Export reports as CSV file", added: 300, removed: 20 });
    expect(found.map((f) => f.title)).not.toContain("Export reports to CSV with no count");
    expect(found.map((f) => f.title)).not.toContain("Export reports as CSV elsewhere");
    expect(found.map((f) => f.title)).not.toContain("Export reports as CSV again");
  });
});

describe("sizeContextOf", () => {
  it("makes a context the schema accepts, flattening and capping every text a stranger wrote", () => {
    const context = sizeContextOf({ title: "T\n@everyone <b>x</b> ".padEnd(900, "x"), text: "line\none", criteria: ["a\nb"], files: [{ path: "src/a.ts", role: "route" }], symbols: ["f"], similar: [{ title: "Old #12\nline", added: 3, removed: 1 }], limits });
    expect(SizeContext.safeParse(context).success).toBe(true);
    expect(context.title.length).toBeLessThanOrEqual(500);
    expect(context.title).not.toMatch(/[\n<>]/);
    expect(context.text).toBe("line one");
    expect(context.similar[0]!.title).not.toMatch(/[\n]|#12/);
    expect(context.limit).toEqual({ target: [1000, 2000], hard: 2500 });
  });
});

describe("sizeAssessment", () => {
  const sure = { estLoc: 1500, estFiles: 5, reviewableNo: false, sure: true, confidence: 0.9 };

  it("rules by the planned sum once there is a plan, and flags over the hard limit", () => {
    const { size, flags } = sizeAssessment({ decision: sure, planned: 3000, limits });
    expect(size).toMatchObject({ estLoc: 1500, planned: 3000, verdict: "over", by: "plan", limit: { target: [1000, 2000], hard: 2500 } });
    expect(flags).toContain("over the size limit");
    expect(flags).not.toContain("size unsure");
    expect(sizeAssessment({ decision: { ...sure, estLoc: 400 }, planned: 3000, limits }).flags).toContain("size unsure");
  });

  it("rules by the decision when there is no plan sum and it is sure; an unsure decision rules nothing", () => {
    expect(sizeAssessment({ decision: { ...sure, estLoc: 4000 }, planned: null, limits }).size).toMatchObject({ verdict: "over", by: "decision" });
    const unsure = sizeAssessment({ decision: { ...sure, estLoc: 4000, sure: false }, planned: null, limits });
    expect(unsure.size.verdict).toBe("within");
    expect(unsure.flags).toEqual([]);
  });

  it("flags over target, and a confident not-reviewable within the limit; nothing else for a plan inside the target", () => {
    expect(sizeAssessment({ decision: sure, planned: 2200, limits }).flags).toEqual(["size over target"]);
    expect(sizeAssessment({ decision: { ...sure, reviewableNo: true }, planned: 900, limits }).flags).toEqual(["size: hard to review as one change"]);
    expect(sizeAssessment({ decision: sure, planned: 900, limits }).flags).toEqual([]);
  });

  it("works with no decision at all (the fast lane, a failed call): the plan's sum alone", () => {
    const { size, flags } = sizeAssessment({ decision: null, planned: 2600, limits });
    expect(size).toMatchObject({ planned: 2600, verdict: "over", by: "plan" });
    expect(flags).toEqual(["over the size limit"]);
  });
});
