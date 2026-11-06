import { describe, expect, it } from "vitest";

import { cuesFrom, toSrt, toVtt } from "./captions.ts";

const w = (word: string, t0: number, t1: number) => ({ w: word, t0, t1 });

describe("cuesFrom", () => {
  it("splits at punctuation and keeps each cue at least 0.6 s", () => {
    const words = [w("Apply", 0, 0.3), w("the", 0.3, 0.4), w("coupon.", 0.4, 0.9), w("Once.", 1.0, 1.1), w("Done", 1.2, 1.5)];
    const cues = cuesFrom(words, { maxChars: 42, maxDurS: 3.5 });
    expect(cues.map((c) => c.text)).toEqual(["Apply the coupon.", "Once.", "Done"]);
    expect(cues[1]).toEqual({ from: 1.0, to: 1.6, text: "Once." });
    for (const c of cues) expect(c.to - c.from).toBeGreaterThanOrEqual(0.6 - 1e-9);
  });

  it("splits at the character cap and the duration cap", () => {
    const long = Array.from({ length: 12 }, (_, i) => w("wordy" + i, i * 0.2, i * 0.2 + 0.2));
    const byChars = cuesFrom(long, { maxChars: 20, maxDurS: 3.5 });
    expect(byChars.length).toBeGreaterThan(2);
    for (const c of byChars) expect(c.text.length).toBeLessThanOrEqual(20);
    const slow = Array.from({ length: 6 }, (_, i) => w("hi", i * 1.0, i * 1.0 + 0.9));
    const byDur = cuesFrom(slow, { maxChars: 42, maxDurS: 3.5 });
    for (const c of byDur) expect(c.to - c.from).toBeLessThanOrEqual(3.5 + 1e-9);
    expect(byDur.length).toBeGreaterThan(1);
  });

  it("returns nothing for no words", () => {
    expect(cuesFrom([], { maxChars: 42, maxDurS: 3.5 })).toEqual([]);
  });
});

describe("subtitle formats", () => {
  const cues = [{ from: 1.2, to: 3.5, text: "Hello there." }, { from: 3661.005, to: 3662, text: "Later." }];
  it("writes SubRip with comma milliseconds", () => {
    expect(toSrt(cues)).toBe("1\n00:00:01,200 --> 00:00:03,500\nHello there.\n\n2\n01:01:01,005 --> 01:01:02,000\nLater.\n");
  });
  it("writes WebVTT with a header and dot milliseconds", () => {
    expect(toVtt(cues)).toBe("WEBVTT\n\n00:00:01.200 --> 00:00:03.500\nHello there.\n\n01:01:01.005 --> 01:01:02.000\nLater.\n");
  });
});
