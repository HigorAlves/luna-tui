// frames: read the text on screen. Tesseract reads each sampled frame of the film, or each image file of a folder.
//   node frames.ts --video /work/walkthrough.mp4 --out /work/qa
//   node frames.ts --images /work --out /work/qa
// Writes <out>/frames.json: { frames: [{ t, text }] } for a film, [{ file, text }] for images.
// Needs no network; reads only under the job dir.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";

import { mustRun, need, parseArgs, probe, regularFile, underJob } from "./common.ts";
import { clampText, sampleTimes } from "./lib/frames.ts";

const args = parseArgs(process.argv.slice(2));
const out = underJob(need(args, "out"));
mkdirSync(out, { recursive: true });
const work = mkdtempSync(join(tmpdir(), "frames-"));
const IMAGES = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const MAX_IMAGES = 40;

async function read(image: string): Promise<string> {
  const ran = await mustRun("tesseract", [image, "stdout", "-l", "eng", "--psm", "11"]);
  return clampText(ran.stdout);
}

const frames: ({ t: number; text: string } | { file: string; text: string })[] = [];
if (typeof args.images === "string") {
  const dir = underJob(args.images);
  const names = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && IMAGES.has(extname(e.name).toLowerCase()))
    .map((e) => e.name)
    .sort()
    .slice(0, MAX_IMAGES);
  for (const name of names) frames.push({ file: name, text: await read(regularFile(join(dir, name), 50 * 1024 * 1024)) });
} else {
  const video = regularFile(need(args, "video"), 4 * 1024 ** 3);
  const info = await probe(video);
  const metaPath = join(video, "..", "meta.json");
  const starts = existsSync(metaPath) ? ((JSON.parse(readFileSync(regularFile(metaPath, 1_000_000), "utf8")) as { scenes?: { start: number }[] }).scenes ?? []).map((s) => s.start) : [];
  for (const t of sampleTimes(starts, info.durationS)) {
    const png = join(work, `f-${t}.png`);
    await mustRun("ffmpeg", ["-y", "-v", "error", "-ss", String(t), "-i", video, "-frames:v", "1", png]);
    frames.push({ t, text: await read(png) });
  }
}
rmSync(work, { recursive: true, force: true });
writeFileSync(join(out, "frames.json"), JSON.stringify({ frames }));
console.log(`read ${frames.length} frames`);
