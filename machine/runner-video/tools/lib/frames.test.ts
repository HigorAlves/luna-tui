import { describe, expect, it } from "vitest";

import { MAX_FRAMES, MAX_TEXT, clampText, sampleTimes } from "./frames.ts";

describe("sampleTimes", () => {
  it("takes a frame every 2 s and 0.3 s after each scene start, sorted, none past the end", () => {
    expect(sampleTimes([0, 4, 7], 9)).toEqual([0, 0.3, 2, 4, 4.3, 6, 7.3, 8]);
  });

  it("keeps a scene's start sample even when it falls on the regular grid, once", () => {
    expect(sampleTimes([2], 5)).toEqual([0, 2, 2.3, 4]);
  });

  it("is at most 150 frames, thinned evenly, with the first and the scene samples' spread kept", () => {
    const times = sampleTimes(Array.from({ length: 40 }, (_, i) => i * 10), 2000);
    expect(times.length).toBeLessThanOrEqual(MAX_FRAMES);
    expect(MAX_FRAMES).toBe(150);
    expect(times[0]).toBe(0);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it("is empty for a film with no length", () => {
    expect(sampleTimes([0], 0)).toEqual([]);
  });
});

describe("clampText", () => {
  it("cuts a frame's text at 4000 characters and drops control characters", () => {
    expect(MAX_TEXT).toBe(4000);
    expect(clampText("a".repeat(5000))).toHaveLength(4000);
    expect(clampText("ab\u0000c\u001b[0m\nd")).toBe("abc[0m\nd");
  });
});
