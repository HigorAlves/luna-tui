import { describe, expect, it } from "vitest";

import { TRIM_SLACK_S, chaptersMetadata, composePlan, ffmpegArgs } from "./compose-plan.ts";
import type { Timeline } from "./timeline.ts";

const tl: Timeline = {
  meta: { w: 1920, h: 1080, fps: 30, dur: 60, clock: "voice", title: "Discounts", commit: "abc1234" },
  scenes: [
    { id: "hook", title: "Discounts in the cart", kind: "card", start: 0, end: 4, text: "x", card: { heading: "Discounts", role: "hook" } },
    { id: "a", title: "A coupon counts once", kind: "demo", start: 4, end: 30, text: "x" },
    { id: "b", title: "The total shows the discount", kind: "demo", start: 30, end: 56, text: "x" },
    { id: "end", title: "That is the change", kind: "card", start: 56, end: 60, text: "x", card: { heading: "Shipped", role: "end" } },
  ],
  texts: [],
  terms: [],
  facts: [],
};
const narration = {
  scenes: [
    { id: "hook", wav: "/work/hook.wav", durationS: 3 },
    { id: "a", wav: "/work/a.wav", durationS: 20 },
    { id: "b", wav: "/work/b.wav", durationS: 10 },
    { id: "end", wav: "/work/end.wav", durationS: 4.5 },
  ],
};
const timing = { marks: [{ scene: "a", t: 5 }, { scene: "b", t: 20 }], videoPath: "/work/rec.webm", durationS: 50 };

describe("composePlan", () => {
  const plan = composePlan(tl, narration, timing);

  it("cuts a demo scene from its mark to the next and holds the last frame when the clip is longer", () => {
    const a = plan.segments.find((s) => s.scene === "a")!;
    expect(a).toEqual({ scene: "a", source: "recording", from: 5, to: 20, holdS: 5 });
    const b = plan.segments.find((s) => s.scene === "b")!;
    expect(b).toEqual({ scene: "b", source: "recording", from: 20, to: 31, holdS: 0 });
  });

  it("runs a card for the longer of its slot and its clip plus 0.3 s", () => {
    expect(plan.segments[0]).toEqual({ scene: "hook", source: "card", from: 0, to: 4, holdS: 0 });
    expect(plan.segments[3]).toEqual({ scene: "end", source: "card", from: 0, to: 4.8, holdS: 0 });
  });

  it("places audio at each scene's start and pushes a clip that would touch the one before it 100 ms later", () => {
    expect(plan.audio).toEqual([
      { scene: "hook", wav: "/work/hook.wav", atS: 0 },
      { scene: "a", wav: "/work/a.wav", atS: 4 },
      { scene: "b", wav: "/work/b.wav", atS: 24.1 },
      { scene: "end", wav: "/work/end.wav", atS: 35 },
    ]);
  });

  it("starts a chapter at each scene and totals the film", () => {
    expect(plan.chapters.map((c) => [c.title, c.startS])).toEqual([
      ["Discounts in the cart", 0],
      ["A coupon counts once", 4],
      ["The total shows the discount", 24],
      ["That is the change", 35],
    ]);
    expect(plan.totalS).toBe(39.8);
  });

  it("refuses a demo scene with no mark or a scene with no narration", () => {
    expect(() => composePlan(tl, narration, { ...timing, marks: [{ scene: "a", t: 5 }] })).toThrow(/mark.*b/);
    expect(() => composePlan(tl, { scenes: narration.scenes.slice(1) }, timing)).toThrow(/narration.*hook/);
  });

  it("without a recording length, the last demo scene runs as long as its clip", () => {
    const p = composePlan(tl, narration, { marks: timing.marks, videoPath: timing.videoPath });
    expect(p.segments.find((s) => s.scene === "b")).toMatchObject({ from: 20, to: 30, holdS: 0 });
  });
});

describe("ffmpegArgs", () => {
  const plan = composePlan(tl, narration, timing);
  const args = ffmpegArgs(plan, {
    recording: "/work/rec.webm",
    cards: { hook: "/work/hook.mp4", end: "/work/end.mp4" },
    out: "/work/out.mp4",
    captions: "/work/out.srt",
    fontSize: 48,
    metadata: "/work/chapters.ffmeta",
  });
  const graph = args[args.indexOf("-filter_complex") + 1]!;

  it("ends with the output path and takes every input once", () => {
    expect(args[args.length - 1]).toBe("/work/out.mp4");
    const inputs = args.flatMap((a, i) => (args[i - 1] === "-i" ? [a] : []));
    expect(inputs).toEqual(["/work/rec.webm", "/work/hook.mp4", "/work/end.mp4", "/work/hook.wav", "/work/a.wav", "/work/b.wav", "/work/end.wav", "/work/chapters.ffmeta"]);
  });

  it("builds one filter graph that names every scene once, then burns captions and normalises loudness", () => {
    for (const id of ["hook", "a", "b", "end"]) expect(graph.match(new RegExp(`\\[v_${id}\\]`, "g"))).toHaveLength(2);
    expect(graph).toContain("concat=n=4:v=1:a=0");
    expect(graph).toContain("tpad=stop_mode=clone:stop_duration=5");
    expect(graph).toContain("subtitles=");
    expect(graph).toContain("adelay=24100:all=1");
    expect(graph).toContain("loudnorm=I=-14:TP=-1:LRA=11");
    expect(args).toEqual(expect.arrayContaining(["-map", "[vout]", "[aout]", "-map_metadata"]));
  });

  it("leaves out the subtitles filter when there are no captions", () => {
    const g = ffmpegArgs(plan, { recording: "/r.webm", cards: { hook: "/h.mp4", end: "/e.mp4" }, out: "/o.mp4", fontSize: 48 });
    expect(g[g.indexOf("-filter_complex") + 1]).not.toContain("subtitles");
    expect(g).not.toContain("-map_metadata");
  });

  it("refuses a card scene with no clip", () => {
    expect(() => ffmpegArgs(plan, { recording: "/r.webm", cards: { hook: "/h.mp4" }, out: "/o.mp4", fontSize: 48 })).toThrow(/end/);
  });
});

describe("chaptersMetadata", () => {
  it("renders an ffmetadata file in milliseconds and escapes the title", () => {
    const plan = composePlan(tl, narration, timing);
    const text = chaptersMetadata({ ...plan, chapters: [{ title: "A=B; #1", startS: 0 }, { title: "Two", startS: 4 }], totalS: 10 });
    expect(text).toBe(";FFMETADATA1\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=4000\ntitle=A\\=B\\; \\#1\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=4000\nEND=10000\ntitle=Two\n");
  });
});

describe("composePlan: hold or trim against the voice", () => {
  it("holds a stretch shorter than the clip, and cuts one longer than the clip by more than a second to clip + 1 s", () => {
    // a: marks 5 to 20 = 15 s against a 10 s clip: 5 s over the slack, cut to 11 s. b: 20 to 50 = 30 s against a 10 s clip: cut to 11 s.
    const longClips = { scenes: narration.scenes.map((s) => (s.id === "a" ? { ...s, durationS: 10 } : s)) };
    const plan = composePlan(tl, longClips, timing);
    expect(plan.segments.find((s) => s.scene === "a")).toEqual({ scene: "a", source: "recording", from: 5, to: 16, holdS: 0 });
    expect(plan.segments.find((s) => s.scene === "b")).toEqual({ scene: "b", source: "recording", from: 20, to: 31, holdS: 0 });
    expect(TRIM_SLACK_S).toBe(1);
  });

  it("keeps a stretch that is longer than its clip by no more than the slack", () => {
    const close = { scenes: narration.scenes.map((s) => (s.id === "a" ? { ...s, durationS: 14.5 } : s)) };
    expect(composePlan(tl, close, timing).segments.find((s) => s.scene === "a")).toEqual({ scene: "a", source: "recording", from: 5, to: 20, holdS: 0 });
  });

  it("starts each scene's audio where the trimmed film puts it", () => {
    const longClips = { scenes: narration.scenes.map((s) => (s.id === "a" ? { ...s, durationS: 10 } : s)) };
    const plan = composePlan(tl, longClips, timing);
    expect(plan.audio.find((a) => a.scene === "b")!.atS).toBe(plan.chapters.find((c) => c.title === "The total shows the discount")!.startS);
  });
});
