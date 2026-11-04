// narrate: the voice. Per scene with text, kokoro renders a clip (cached by the hash of voice and
// text), whisper gives its word timestamps, ffmpeg normalises it, and narration.json lists them all.
//   node narrate.ts --timeline /work/timeline.json --out /work/narration [--voice af_heart]
//   node narrate.ts --warm        (the image build: fetch the models once)
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { JOB, mustRun, need, parseArgs, probe, regularFile, round3, underJob } from "./common.ts";
import { cuesFrom } from "./lib/captions.ts";
import { Timeline } from "./lib/timeline.ts";
import { configureModels, loadAsr, loadTts, words, type AsrWord } from "./speech.ts";

const args = parseArgs(process.argv.slice(2));
const voice = typeof args.voice === "string" ? args.voice : "af_heart";

if (args.warm) {
  configureModels(true);
  const tts = await loadTts();
  const audio = await tts.generate("The cart now shows every discount.", { voice: voice as never });
  const wav = "/tmp/warm/warm.wav";
  mkdirSync("/tmp/warm", { recursive: true });
  await audio.save(wav);
  const asr = await loadAsr();
  const heard = await words(asr, wav);
  if (heard.length === 0) throw new Error("warm-up: whisper heard nothing in kokoro's clip");
  console.log(`models ready: ${heard.map((w) => w.w).join(" ")}`);
  process.exit(0);
}

configureModels(false);
const timelinePath = regularFile(need(args, "timeline"), 2_000_000);
const out = underJob(need(args, "out"));
const cache = underJob(join(JOB, "cache"));
mkdirSync(out, { recursive: true });
mkdirSync(cache, { recursive: true });
const timeline = Timeline.parse(JSON.parse(readFileSync(timelinePath, "utf8")));

const tts = await loadTts();
const asr = await loadAsr();
const safe = (id: string) => id.replace(/[^A-Za-z0-9_-]/g, "_");

const scenes: { id: string; wav: string; durationS: number; words: AsrWord[] }[] = [];
const captionWords: AsrWord[] = [];
for (const scene of timeline.scenes) {
  if (!scene.text.trim()) continue;
  const key = createHash("sha256").update(`${voice}\n${scene.text}`).digest("hex");
  const cached = join(cache, `${key}.wav`);
  if (!existsSync(cached)) {
    const audio = await tts.generate(scene.text, { voice: voice as never });
    await audio.save(cached);
  }
  const raw = join(out, `scene-${safe(scene.id)}.wav`);
  copyFileSync(cached, raw);
  const norm = join(out, `scene-${safe(scene.id)}.norm.wav`);
  await mustRun("ffmpeg", ["-y", "-v", "error", "-i", raw, "-af", "loudnorm=I=-14:TP=-1", "-ar", "24000", norm]);
  const wordsCache = join(cache, `${key}.words.json`);
  let heard: AsrWord[];
  if (existsSync(wordsCache)) heard = JSON.parse(readFileSync(wordsCache, "utf8")) as AsrWord[];
  else {
    heard = await words(asr, norm);
    writeFileSync(wordsCache, JSON.stringify(heard));
  }
  writeFileSync(join(out, `scene-${safe(scene.id)}.words.json`), JSON.stringify(heard, null, 2));
  const info = await probe(norm);
  scenes.push({ id: scene.id, wav: norm, durationS: round3(info.durationS), words: heard });
  for (const w of heard) captionWords.push({ w: w.w, t0: round3(w.t0 + scene.start), t1: round3(w.t1 + scene.start) });
}

writeFileSync(
  join(out, "narration.json"),
  JSON.stringify({ voice, scenes, captions: cuesFrom(captionWords, { maxChars: 42, maxDurS: 3.5 }) }, null, 2),
);
timeline.vo = { status: "MEASURED" };
writeFileSync(timelinePath, JSON.stringify(timeline, null, 2));
console.log(`narrated ${scenes.length} scenes, ${round3(scenes.reduce((a, s) => a + s.durationS, 0))}s of voice`);
