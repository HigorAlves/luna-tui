import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { loadCases } from "./cases.ts";
import { casesTable } from "./preflight.ts";

const EVALS = resolve(import.meta.dirname, "..");

describe("the agent packs' first cases", () => {
  it("has three plan cases that load and carry a rubric", () => {
    const cases = loadCases(EVALS, "plan");
    expect(cases.map((c) => c.id)).toEqual(["cli-sum-names", "web-item-count", "web-vague-speed"].sort());
    for (const c of cases) {
      expect(c.expect.rubric.length).toBeGreaterThan(80);
      expect(c.input.context.plan?.risk).toBeDefined();
    }
  });

  it("has three decompose cases: a small one, a cross-module one and one that must split", () => {
    const cases = loadCases(EVALS, "decompose");
    expect(cases.map((c) => c.id)).toEqual(["cart-small-fixes", "cart-count-and-clear", "cart-csv-and-storage"].sort());
    for (const c of cases) {
      const split = c.input.context.split!;
      const ids = split.origin.criteria.map((k) => k.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(split.children).toEqual([]);
      expect(split.round).toBe(1);
    }
  });

  it("lists an agent pack's cases for a person to read", () => {
    const rows = casesTable(EVALS, "plan");
    expect(rows).toHaveLength(3);
    expect(rows.join("\n")).toContain("web-vague-speed");
    expect(rows.join("\n")).not.toContain("no reading");
  });
});
