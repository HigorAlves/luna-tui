import { describe, expect, it } from "vitest";

import { FACTORY_DEFAULTS, SIZE_FILE_ANCHORS, SIZE_LOC_ANCHORS, PACKS, filesOf, locOf, sizeLimits, sizeVerdict } from "./index.ts";

describe("the size scale", () => {
  it("has one anchor per rubric level of the two size questions", () => {
    const q = PACKS.size_estimate.questions as Record<string, { rubric: Record<string, string> }>;
    expect(SIZE_LOC_ANCHORS).toEqual([50, 200, 500, 1000, 2000, 4000, 8000]);
    expect(SIZE_FILE_ANCHORS).toEqual([2, 5, 10, 25, 50]);
    expect(Object.keys(q.est_loc!.rubric)).toHaveLength(SIZE_LOC_ANCHORS.length);
    expect(Object.keys(q.est_files!.rubric)).toHaveLength(SIZE_FILE_ANCHORS.length);
  });

  it("reads a whole score as its anchor, a fraction on a log scale between the two around it, and clamps the ends", () => {
    expect(locOf(0)).toBe(50);
    expect(locOf(2)).toBe(500);
    expect(locOf(6)).toBe(8000);
    // the geometric middle of 500 and 1000 is 707, rounded to ten
    expect(locOf(2.5)).toBe(710);
    expect(locOf(-3)).toBe(50);
    expect(locOf(99)).toBe(8000);
    expect(filesOf(0)).toBe(2);
    expect(filesOf(1.5)).toBe(7);
    expect(filesOf(9)).toBe(50);
  });
});

describe("sizeLimits and sizeVerdict", () => {
  it("answers the five numbers with the target sorted", () => {
    expect(sizeLimits(FACTORY_DEFAULTS.size)).toEqual({ target: [1000, 2000], hard: 2500, maxChildren: 8, maxRounds: 3, depth: 2 });
    expect(sizeLimits({ ...FACTORY_DEFAULTS.size, target_loc: [2000, 1000] }).target).toEqual([1000, 2000]);
  });

  it("is over above the hard limit, over_target above the target's top, else within", () => {
    const limits = sizeLimits(FACTORY_DEFAULTS.size);
    expect(sizeVerdict(2501, limits)).toBe("over");
    expect(sizeVerdict(2500, limits)).toBe("over_target");
    expect(sizeVerdict(2001, limits)).toBe("over_target");
    expect(sizeVerdict(2000, limits)).toBe("within");
  });
});
