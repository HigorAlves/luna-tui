import { describe, expect, it } from "vitest";

import { PACKS, SIZE_SCALED_PACKS, sizeScale } from "./index.ts";

describe("sizeScale", () => {
  it("is 1 up to 2,000 lines, 2 up to 8,000, 3 above", () => {
    expect(sizeScale(0)).toBe(1);
    expect(sizeScale(2000)).toBe(1);
    expect(sizeScale(2001)).toBe(2);
    expect(sizeScale(8000)).toBe(2);
    expect(sizeScale(8001)).toBe(3);
    expect(sizeScale(40_000)).toBe(3);
  });
  it("is 1 when there is no estimate", () => {
    expect(sizeScale(null)).toBe(1);
    expect(sizeScale(undefined)).toBe(1);
    expect(sizeScale(Number.NaN)).toBe(1);
  });
  it("scales the feature card's agent stages and leaves the fast lane alone", () => {
    expect([...SIZE_SCALED_PACKS].sort()).toEqual(["build_tests", "e2e", "implementing", "plan", "test_design", "verifying"]);
  });
});

describe("the planner's own room", () => {
  it("gets 60 turns and 20 minutes, since it runs before any plan exists", () => {
    expect(PACKS.plan.maxTurns).toBe(60);
    expect(PACKS.plan.timeoutMs).toBe(20 * 60_000);
  });
});
