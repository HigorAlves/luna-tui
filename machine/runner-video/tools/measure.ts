// measure: the numeric checks on the finished film, and the contact sheets a critic reads.
//   node measure.ts --video /work/walkthrough.mp4 --timeline /work/timeline.json --out /work/qa
// Writes report.json ({ info, picture, audio, checks, verdict }), report.md, beats_sheet.jpg,
// hook_sheet.jpg, phone_sheet.jpg and transcript.txt. The host recomputes the verdict from the report.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { mustRun, need, parseArgs, probe, regularFile, round3, run, runBytes, underJob } from "./common.ts";
import { Timeline } from "./lib/timeline.ts";
import { analyzeFrames, checks, verdictOf, type AudioReport, type FrameStat } from "./lib/measure.ts";
import { configureModels, loadAsr, transcript } from "./speech.ts";

const args = parseArgs(process.argv.slice(2));
const video = regularFile(need(args, "video"), 4 * 1024 ** 3);
const timeline = Timeline.parse(JSON.parse(readFileSync(regularFile(need(args, "timeline"), 2_000_000), "utf8")));
const out = underJob(need(args, "out"));
mkdirSync(out, { recursive: true });
const info = await probe(video);

// The timeline's own times are the voice clock; judge the picture against where compose put each scene.
let effective = timeline;
const metaPath = join(video, "..", "meta.json");
if (existsSync(metaPath)) {
  const meta = JSON.parse(readFileSync(regularFile(metaPath, 1_000_000), "utf8")) as { scenes?: { id: string; start: number; end: number }[]; plannedS?: number };
  if (meta.scenes) {
    const by = new Map(meta.scenes.map((s) => [s.id, s]));
    effective = {
      ...timeline,
      meta: { ...timeline.meta, dur: meta.plannedS ?? timeline.meta.dur },
      scenes: timeline.scenes.map((s) => ({ ...s, start: by.get(s.id)?.start ?? s.start, end: by.get(s.id)?.end ?? s.end })),
    };
  }
}

// Frame statistics on 192-px greyscale frames at the film's frame rate.
const fps = info.fps || timeline.meta.fps;
const tileW = 192;
const tileH = Math.max(2, Math.round(((tileW * info.h) / info.w) / 2) * 2);
const frameBytes = tileW * tileH;
const frames: FrameStat[] = [];
let carry = Buffer.alloc(0);
let prev: Buffer | null = null;
const consume = (chunk: Buffer) => {
  carry = Buffer.concat([carry, chunk]);
  while (carry.length >= frameBytes) {
    const f = carry.subarray(0, frameBytes);
    carry = carry.subarray(frameBytes);
    let sum = 0;
    for (let i = 0; i < frameBytes; i++) sum += f[i]!;
    const mean = sum / frameBytes;
    let sq = 0;
    let d = 0;
    for (let i = 0; i < frameBytes; i++) {
      sq += (f[i]! - mean) ** 2;
      if (prev) d += Math.abs(f[i]! - prev[i]!);
    }
    frames.push({ mean, std: Math.sqrt(sq / frameBytes), diff: prev ? d / frameBytes : 0 });
    prev = Buffer.from(f);
  }
};
const raw = await runBytes("ffmpeg", ["-v", "error", "-i", video, "-vf", `fps=${fps},scale=${tileW}:${tileH},format=gray`, "-f", "rawvideo", "-"], consume);
if (raw.code !== 0) throw new Error(`frame statistics failed: ${raw.stderr.slice(-400)}`);
const picture = analyzeFrames(frames, fps, { freezeS: 1.0, freezeEps: 0.25, flatStd: 6, frame0Mean: 8 });

// Loudness, true peak, silences.
const audio: AudioReport = { lufs: null, truePeak: null, silences: [] };
if (info.hasAudio) {
  const ebu = await run("ffmpeg", ["-nostats", "-i", video, "-vn", "-af", "ebur128=peak=true", "-f", "null", "-"]);
  const summary = ebu.stderr.slice(ebu.stderr.lastIndexOf("Summary:"));
  audio.lufs = Number(/I:\s+(-?[\d.]+) LUFS/.exec(summary)?.[1] ?? NaN);
  audio.truePeak = Number(/True peak:\s+Peak:\s+(-?[\d.]+) dBFS/.exec(summary)?.[1] ?? NaN);
  if (!Number.isFinite(audio.lufs)) audio.lufs = null;
  if (!Number.isFinite(audio.truePeak)) audio.truePeak = null;
  const sil = await run("ffmpeg", ["-nostats", "-i", video, "-vn", "-af", "silencedetect=noise=-50dB:d=2", "-f", "null", "-"]);
  let from: number | null = null;
  for (const line of sil.stderr.split("\n")) {
    const s = /silence_start: (-?[\d.]+)/.exec(line);
    const e = /silence_end: (-?[\d.]+)/.exec(line);
    if (s) from = Number(s[1]);
    if (e && from !== null) {
      audio.silences.push({ from: Math.max(0, round3(from)), to: round3(Number(e[1])) });
      from = null;
    }
  }
}

const found = checks({ info, picture, audio, timeline: effective });
const verdict = verdictOf(found);

// Contact sheets: frames to a temp folder inside the job, tiled by ffmpeg.
async function sheet(name: string, times: number[], tile: number, columns: number) {
  const dir = join(out, `.sheet-${name}`);
  mkdirSync(dir, { recursive: true });
  let n = 0;
  for (const t of times) {
    const t0 = Math.min(Math.max(0, t), Math.max(0, info.durationS - 0.05));
    const r = await run("ffmpeg", ["-y", "-v", "error", "-ss", String(t0), "-i", video, "-frames:v", "1", "-vf", `scale=${tile}:-2`, join(dir, `${String(++n).padStart(3, "0")}.png`)]);
    if (r.code !== 0) n--;
  }
  if (n > 0) {
    const rows = Math.ceil(n / columns);
    await mustRun("ffmpeg", ["-y", "-v", "error", "-framerate", "1", "-i", join(dir, "%03d.png"), "-vf", `tile=${columns}x${rows}`, "-frames:v", "1", "-q:v", "4", join(out, `${name}.jpg`)]);
  }
  rmSync(dir, { recursive: true, force: true });
}
await sheet("beats_sheet", effective.scenes.map((s) => s.start + 0.3), 480, 4);
await sheet("hook_sheet", [0, 0.5, 1, 1.5, 2, 2.5, 3], 480, 4);
const perSecond = Array.from({ length: Math.min(60, Math.floor(info.durationS)) }, (_, i) => (i * Math.floor(info.durationS)) / Math.min(60, Math.floor(info.durationS)));
await sheet("phone_sheet", perSecond, 360, 10);

// What the film says, heard again from the final audio.
if (info.hasAudio) {
  configureModels(false);
  writeFileSync(join(out, "transcript.txt"), (await transcript(await loadAsr(), video)) + "\n");
}

const report = { info, picture, audio, checks: found, verdict };
writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2));
const lines = [
  `# Film measurements`,
  ``,
  `Verdict: **${verdict}** · ${round3(info.durationS)} s · ${info.w}x${info.h} @ ${round3(info.fps)} fps`,
  `Loudness: ${audio.lufs ?? "n/a"} LUFS · true peak ${audio.truePeak ?? "n/a"} dBTP · ${audio.silences.length} silences over 2 s`,
  ``,
  found.length === 0 ? "No findings." : found.map((c) => `- ${c.level} ${c.check}: ${c.detail}`).join("\n"),
  ``,
];
writeFileSync(join(out, "report.md"), lines.join("\n"));
console.log(`measured: ${verdict}, ${found.length} findings`);
