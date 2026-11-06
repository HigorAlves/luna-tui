// The numeric checks on a finished film, as pure functions. The tool inside the image feeds them
// frame statistics (192-px greyscale mean, std and the mean absolute difference to the previous
// frame), the loudness and the silences; the host recomputes the verdict from the report. Rules after
// video-director's qa_video: flashes, pops, frozen runs, flat frames, frame 0, loudness, true peak.
import type { Timeline } from "./timeline.ts";

export type FrameStat = { mean: number; std: number; diff: number };
export type FrameOpts = { freezeS: number; freezeEps: number; flatStd: number; frame0Mean: number };
/** Times are seconds from the start of the film. */
export type PictureReport = {
  frame0Flat: boolean;
  medianStep: number;
  flashes: number[];
  pops: number[];
  cuts: number[];
  frozen: { from: number; to: number }[];
  flat: number[];
};

const median = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const sec = (frame: number, fps: number) => Math.round((frame / fps) * 1000) / 1000;

export function analyzeFrames(frames: FrameStat[], fps: number, opts: FrameOpts): PictureReport {
  const diff = (i: number) => frames[i]?.diff ?? 0;
  const medianStep = median(frames.slice(1).map((f) => f.diff));
  const flashThr = Math.max(2, 4 * medianStep);
  const report: PictureReport = {
    frame0Flat: frames.length > 0 && frames[0]!.mean < opts.frame0Mean,
    medianStep,
    flashes: [],
    pops: [],
    cuts: [],
    frozen: [],
    flat: [],
  };
  const flashAt = new Set<number>();
  for (let i = 1; i < frames.length - 1; i++) {
    const neighboursMatch = Math.abs(frames[i + 1]!.mean - frames[i - 1]!.mean) < flashThr / 2;
    if (diff(i) > flashThr && diff(i + 1) > flashThr && neighboursMatch) flashAt.add(i);
  }
  for (let i = 1; i < frames.length; i++) {
    if (flashAt.has(i)) {
      report.flashes.push(sec(i, fps));
      continue;
    }
    if (flashAt.has(i - 1)) continue; // the way back out of a flash
    const local = median(frames.slice(Math.max(1, i - 5), i + 6).map((f) => f.diff));
    const d = diff(i);
    if (d > Math.max(6, 3.5 * (local + 0.5))) report.cuts.push(sec(i, fps));
    else if (d > 2 && d > 3 * diff(i - 1) && d > 3 * diff(i + 1)) report.pops.push(sec(i, fps));
  }
  const need = Math.ceil(opts.freezeS * fps);
  let run = 0;
  for (let i = 1; i <= frames.length; i++) {
    if (i < frames.length && diff(i) < opts.freezeEps) run++;
    else {
      if (run >= need) report.frozen.push({ from: sec(i - run, fps), to: sec(i, fps) });
      run = 0;
    }
  }
  for (let i = 1; i < frames.length; i++) if (frames[i]!.std < opts.flatStd) report.flat.push(sec(i, fps));
  return report;
}

export type Check = { level: "FAIL" | "WARN"; check: string; detail: string };
export type AudioReport = { lufs: number | null; truePeak: number | null; silences: { from: number; to: number }[] };

export const TARGET_LUFS = -14;
export const MAX_TRUE_PEAK = -1;

export function checks(input: {
  info: { durationS: number; hasAudio: boolean };
  picture: PictureReport;
  audio: AudioReport;
  timeline: Timeline;
  /** The film's length limit (`evidence.video_budget_s`); 240 when absent. */
  maxS?: number;
}): Check[] {
  const { info, picture, audio, timeline } = input;
  const out: Check[] = [];
  const cards = timeline.scenes.filter((s) => s.kind === "card");
  const inCard = (from: number, to: number) => cards.some((c) => from >= c.start - 0.1 && to <= c.end + 0.1);
  const fail = (check: string, detail: string) => out.push({ level: "FAIL", check, detail });
  const warn = (check: string, detail: string) => out.push({ level: "WARN", check, detail });

  if (picture.frame0Flat) fail("frame0", "frame 0 is flat or dark: the film opens on nothing");
  if (picture.flashes.length > 0) fail("flashes", `a single frame unlike both neighbours at ${picture.flashes.join(", ")}s`);
  if (picture.pops.length > 0) warn("pops", `a jump much bigger than its neighbours at ${picture.pops.join(", ")}s`);
  const frozen = picture.frozen.filter((r) => !inCard(r.from, r.to));
  if (frozen.length > 0) warn("frozen", frozen.map((r) => `frozen from ${r.from}s to ${r.to}s outside a card`).join("; "));
  const flat = picture.flat.filter((t) => t > 0.5 && t < info.durationS - 0.5 && !inCard(t, t));
  if (flat.length > 0) warn("flat", `flat frames mid-film at ${flat.slice(0, 5).join(", ")}s${flat.length > 5 ? ` and ${flat.length - 5} more` : ""}`);

  const maxS = input.maxS ?? 240;
  if (info.durationS > maxS) fail("duration", `the film runs ${info.durationS}s, over ${maxS}s`);
  else if (Math.abs(info.durationS - timeline.meta.dur) > 0.1 * timeline.meta.dur) {
    warn("duration", `the film runs ${info.durationS}s, more than 10% off the timeline's ${timeline.meta.dur}s`);
  }

  if (!info.hasAudio) fail("audio", "the film has no audio track");
  else {
    if (audio.lufs !== null && Math.abs(audio.lufs - TARGET_LUFS) > 1) fail("loudness", `${audio.lufs} LUFS, not ${TARGET_LUFS} ± 1`);
    if (audio.truePeak !== null && audio.truePeak > MAX_TRUE_PEAK) fail("truePeak", `true peak ${audio.truePeak} dBTP, over ${MAX_TRUE_PEAK}`);
    const long = audio.silences.filter((s) => s.to - s.from > 4);
    if (long.length > 0) warn("silence", long.map((s) => `silent from ${s.from}s to ${s.to}s`).join("; "));
  }

  const short = timeline.scenes.filter((s) => s.kind === "demo" && s.end - s.start < 2);
  if (short.length > 0) warn("demoLength", `demo scene ${short.map((s) => `"${s.id}"`).join(", ")} is under 2s`);
  return out;
}

export const verdictOf = (cs: Check[]): "pass" | "fail" => (cs.some((c) => c.level === "FAIL") ? "fail" : "pass");
