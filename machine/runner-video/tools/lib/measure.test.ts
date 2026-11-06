import { describe, expect, it } from "vitest";

import { type Timeline } from "./timeline.ts";
import { analyzeFrames, checks, verdictOf } from "./measure.ts";

const OPTS = { freezeS: 1.0, freezeEps: 0.25, flatStd: 6, frame0Mean: 8 };
const FPS = 10;

type F = { mean: number; std: number; diff: number };
/** n frames of gentle motion: the mean drifts by 1 a frame, so every diff is 1. */
const moving = (n: number): F[] => Array.from({ length: n }, (_, i) => ({ mean: 100 + (i % 2), std: 40, diff: i === 0 ? 0 : 1 }));

describe("analyzeFrames", () => {
  it("finds nothing in steady motion", () => {
    const r = analyzeFrames(moving(60), FPS, OPTS);
    expect(r).toEqual({ frame0Flat: false, medianStep: 1, flashes: [], pops: [], cuts: [], frozen: [], flat: [] });
  });

  it("flags a dark frame 0", () => {
    const f = moving(60);
    f[0] = { mean: 2, std: 40, diff: 0 };
    expect(analyzeFrames(f, FPS, OPTS).frame0Flat).toBe(true);
  });

  it("plants a flash: one frame unlike both neighbours, reported in seconds", () => {
    const f = moving(60);
    f[30] = { mean: 240, std: 40, diff: 140 };
    f[31] = { ...f[31]!, diff: 140 };
    const r = analyzeFrames(f, FPS, OPTS);
    expect(r.flashes).toEqual([3]);
    expect(r.cuts).toEqual([]);
    expect(r.pops).toEqual([]);
  });

  it("lists a hard cut apart from a pop, and a pop is a small jump much bigger than its neighbours", () => {
    const f = moving(60);
    f[20] = { mean: 180, std: 40, diff: 80 };
    f[40] = { ...f[40]!, diff: 4 };
    const r = analyzeFrames(f, FPS, OPTS);
    expect(r.cuts).toEqual([2]);
    expect(r.pops).toEqual([4]);
    expect(r.flashes).toEqual([]);
  });

  it("finds a frozen run of a second or more and ignores a shorter one", () => {
    const f = moving(80);
    for (let i = 20; i < 35; i++) f[i] = { ...f[i]!, diff: 0.05 };
    for (let i = 50; i < 55; i++) f[i] = { ...f[i]!, diff: 0.05 };
    expect(analyzeFrames(f, FPS, OPTS).frozen).toEqual([{ from: 2, to: 3.5 }]);
  });

  it("lists flat frames after frame 0", () => {
    const f = moving(60);
    f[25] = { mean: 100, std: 2, diff: 1 };
    expect(analyzeFrames(f, FPS, OPTS).flat).toEqual([2.5]);
  });
});

const tl: Timeline = {
  meta: { w: 1920, h: 1080, fps: 30, dur: 60, clock: "voice", title: "t", commit: "abc1234" },
  scenes: [
    { id: "hook", title: "h", kind: "card", start: 0, end: 4, text: "x" },
    { id: "a", title: "a", kind: "demo", start: 4, end: 30, text: "x" },
    { id: "b", title: "b", kind: "demo", start: 30, end: 56, text: "x" },
    { id: "end", title: "e", kind: "card", start: 56, end: 60, text: "x" },
  ],
  texts: [],
  terms: [],
  facts: [],
};
const clean = { frame0Flat: false, medianStep: 1, flashes: [], pops: [], cuts: [], frozen: [], flat: [] };
const good = { info: { durationS: 60, hasAudio: true }, picture: clean, audio: { lufs: -14, truePeak: -1.5, silences: [] }, timeline: tl };

describe("checks", () => {
  it("passes a clean film", () => {
    expect(checks(good)).toEqual([]);
    expect(verdictOf([])).toBe("pass");
  });

  it("fails on a flat frame 0, a flash, no audio, loud audio and a film over four minutes", () => {
    const out = checks({
      info: { durationS: 250, hasAudio: false },
      picture: { ...clean, frame0Flat: true, flashes: [12.3] },
      audio: { lufs: null, truePeak: null, silences: [] },
      timeline: tl,
    });
    const fails = out.filter((c) => c.level === "FAIL").map((c) => c.check);
    expect(fails).toEqual(expect.arrayContaining(["frame0", "flashes", "audio", "duration"]));
    expect(verdictOf(out)).toBe("fail");
    const loud = checks({ ...good, audio: { lufs: -9, truePeak: 0.5, silences: [] } });
    expect(loud.filter((c) => c.level === "FAIL").map((c) => c.check)).toEqual(["loudness", "truePeak"]);
  });

  it("warns on pops, a freeze outside a card, a long silence, a short demo scene and a duration off by over 10 percent", () => {
    const shortDemo = { ...tl, scenes: tl.scenes.map((s) => (s.id === "b" ? { ...s, end: 31 } : s)) };
    const out = checks({
      info: { durationS: 70, hasAudio: true },
      picture: { ...clean, pops: [8], frozen: [{ from: 10, to: 12 }, { from: 1, to: 2.5 }] },
      audio: { lufs: -14.5, truePeak: -2, silences: [{ from: 20, to: 25 }] },
      timeline: shortDemo,
    });
    expect(out.every((c) => c.level === "WARN")).toBe(true);
    expect(out.map((c) => c.check).sort()).toEqual(["demoLength", "duration", "frozen", "pops", "silence"]);
    expect(out.find((c) => c.check === "frozen")!.detail).toMatch(/10/);
    expect(out.find((c) => c.check === "frozen")!.detail).not.toMatch(/\b1\b.*2\.5/);
    expect(verdictOf(out)).toBe("pass");
  });
});

describe("checks with a budget", () => {
  it("fails a film over the budget it is given, and not one under it", () => {
    expect(checks({ ...good, info: { durationS: 100, hasAudio: true }, maxS: 90 }).filter((c) => c.level === "FAIL").map((c) => c.check)).toContain("duration");
    expect(checks({ ...good, info: { durationS: 100, hasAudio: true }, maxS: 120 }).filter((c) => c.level === "FAIL")).toEqual([]);
    expect(checks({ ...good, info: { durationS: 250, hasAudio: true } }).filter((c) => c.level === "FAIL").map((c) => c.check)).toContain("duration");
  });
});
