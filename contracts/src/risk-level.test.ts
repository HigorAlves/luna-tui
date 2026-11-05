import { describe, expect, it } from "vitest";

import { riskLevelOf } from "./packs.ts";

// A score on the wire is 0 to 2; its level is the rounded score plus 1, so 1 to 3.
const at = (blast: number, reversibility: number, data: number) =>
  riskLevelOf({ blast_radius: { score: blast }, reversibility: { score: reversibility }, data_sensitivity: { score: data } });

describe("the plan's risk is the product of the three levels", () => {
  it("is low at 1 x 1 x 3 = 3: one factor at its worst does not make a change risky by itself", () => {
    expect(at(0, 0, 2)).toBe("low");
  });

  it("is medium at 3 x 3 x 1 = 9 and high at 2 x 2 x 3 = 12", () => {
    expect(at(2, 2, 0)).toBe("medium");
    expect(at(1, 1, 2)).toBe("high");
  });

  it("keeps the ends where they were: 1 x 1 x 1 is low, 3 x 3 x 3 is high", () => {
    expect(at(0, 0, 0)).toBe("low");
    expect(at(2, 2, 2)).toBe("high");
  });
});
