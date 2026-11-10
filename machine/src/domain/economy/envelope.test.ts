import { describe, expect, it } from "vitest";

import { ENVELOPE_KEEP, addSample, envelopeOf } from "./envelope.ts";

describe("envelope", () => {
  it("is the 90th percentile of five passing runs times 1.25", () => {
    // sorted 10..50: index 0.9 * 4 = 3.6 -> 40 + 0.6 * 10 = 46; 46 * 1.25 = 57.5
    expect(envelopeOf([30, 10, 50, 20, 40], 5)).toBeCloseTo(57.5, 6);
  });

  it("is null under the minimum number of samples", () => {
    expect(envelopeOf([10, 20, 30, 40], 5)).toBeNull();
  });

  it("is the sample itself times the margin for one sample when one is enough", () => {
    expect(envelopeOf([8], 1)).toBe(10);
  });

  it("keeps the last 500 samples", () => {
    let samples: number[] = [];
    for (let i = 1; i <= 503; i++) samples = addSample(samples, i);
    expect(samples).toHaveLength(ENVELOPE_KEEP);
    expect(samples[0]).toBe(4);
    expect(samples.at(-1)).toBe(503);
  });

  it("does not change the list it is given", () => {
    const before = [1, 2];
    addSample(before, 3);
    expect(before).toEqual([1, 2]);
  });
});
