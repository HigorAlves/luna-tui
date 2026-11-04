// compose: cut the recording and the cards to the narration and write the film.
//   node compose.ts --job /work
// Reads timeline.json, narration/narration.json, cards/card-<id>.mp4 and timing.json
// ({ marks, videoPath }); writes walkthrough.mp4, cover.jpg, captions.srt, captions.vtt,
// chapters.ffmeta and meta.json. Fails, with the reason, when the film would pass four minutes.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { JOB, mustRun, parseArgs, probe, regularFile, round3, underJob } from "./common.ts";
import { cuesFrom, toSrt, toVtt, type Word } from "./lib/captions.ts";
import { chaptersMetadata, composePlan, ffmpegArgs } from "./lib/compose-plan.ts";
import { MAX_DURATION_S, Timeline } from "./lib/timeline.ts";

const args = parseArgs(process.argv.slice(2));
const job = underJob(typeof args.job === "string" ? args.job : JOB);
const at = (name: string) => join(job, name);
const safe = (id: string) => id.replace(/[^A-Za-z0-9_-]/g, "_");

const timeline = Timeline.parse(JSON.parse(readFileSync(regularFile(at("timeline.json"), 2_000_000, job), "utf8")));
const narration = JSON.parse(readFileSync(regularFile(at("narration/narration.json"), 20_000_000, job), "utf8")) as {
  voice: string;
  scenes: { id: string; wav: string; durationS: number; words: Word[] }[];
};
const timing = JSON.parse(readFileSync(regularFile(at("timing.json"), 1_000_000, job), "utf8")) as { marks: { scene: string; t: number }[]; videoPath: string };

// The recording path comes from the recorder: only a regular file under the job dir is used.
const recording = regularFile(timing.videoPath, 4 * 1024 ** 3, job);
const recInfo = await probe(recording);
const clips = { scenes: narration.scenes.map((s) => ({ id: s.id, wav: regularFile(s.wav, 200_000_000, job), durationS: s.durationS })) };
const plan = composePlan(timeline, clips, { marks: timing.marks, videoPath: recording, durationS: round3(recInfo.durationS) });
if (plan.totalS > MAX_DURATION_S) throw new Error(`the film would run ${plan.totalS}s, over the ${MAX_DURATION_S}s limit`);

// Captions follow the audio where the plan actually placed it.
const placed = new Map(plan.audio.map((a) => [a.scene, a.atS]));
const words: Word[] = narration.scenes.flatMap((s) => s.words.map((w) => ({ w: w.w, t0: round3(w.t0 + (placed.get(s.id) ?? 0)), t1: round3(w.t1 + (placed.get(s.id) ?? 0)) })));
const cues = cuesFrom(words, { maxChars: 42, maxDurS: 3.5 });
writeFileSync(at("captions.srt"), toSrt(cues));
writeFileSync(at("captions.vtt"), toVtt(cues));
writeFileSync(at("chapters.ffmeta"), chaptersMetadata(plan));

const cards: Record<string, string> = {};
for (const seg of plan.segments) if (seg.source === "card") cards[seg.scene] = regularFile(at(`cards/card-${safe(seg.scene)}.mp4`), 2 * 1024 ** 3, job);

const out = at("walkthrough.mp4");
await mustRun("ffmpeg", ffmpegArgs(plan, { recording, cards, out, captions: at("captions.srt"), fontSize: 48, metadata: at("chapters.ffmeta") }));

const firstDemo = timeline.scenes.find((s) => s.kind === "demo");
const coverAt = round3((plan.chapters.find((c) => c.title === firstDemo?.title)?.startS ?? 0) + 0.5);
await mustRun("ffmpeg", ["-y", "-v", "error", "-ss", String(coverAt), "-i", out, "-frames:v", "1", "-q:v", "3", at("cover.jpg")]);

const info = await probe(out);
const version = async (cmd: string) => (await mustRun(cmd, ["-version"])).stdout.split("\n")[0] ?? "";
// Where each scene landed in the finished film: measure judges the film against these.
const starts = plan.chapters.map((c) => c.startS);
const scenes = timeline.scenes.map((s, i) => ({ id: s.id, kind: s.kind, title: s.title, start: starts[i]!, end: starts[i + 1] ?? plan.totalS }));
writeFileSync(
  at("meta.json"),
  JSON.stringify(
    {
      engines: { voice: "kokoro-js onnx-community/Kokoro-82M-v1.0-ONNX q8", asr: "transformers.js Xenova/whisper-tiny.en" },
      voice: narration.voice,
      resolution: `${info.w}x${info.h}`,
      fps: info.fps,
      commit: timeline.meta.commit,
      durationS: round3(info.durationS),
      plannedS: plan.totalS,
      scenes,
      tools: { ffmpeg: await version("ffmpeg"), ffprobe: await version("ffprobe") },
    },
    null,
    2,
  ),
);
console.log(`composed ${plan.segments.length} scenes into ${round3(info.durationS)}s`);
