// cards: render each `card` scene of the timeline to an mp4. The card page is driven by time
// (window.seek), so each frame is a screenshot at t = i / FPS; ffmpeg joins the PNGs.
//   node cards.ts --timeline /work/timeline.json --narration /work/narration/narration.json --out /work/cards
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { mustRun, need, parseArgs, regularFile, round3, underJob } from "./common.ts";
import { Timeline } from "./lib/timeline.ts";

const args = parseArgs(process.argv.slice(2));
const timeline = Timeline.parse(JSON.parse(readFileSync(regularFile(need(args, "timeline"), 2_000_000), "utf8")));
const narration = JSON.parse(readFileSync(regularFile(need(args, "narration"), 20_000_000), "utf8")) as { scenes: { id: string; durationS: number }[] };
const out = underJob(need(args, "out"));
mkdirSync(out, { recursive: true });

// Playwright is installed globally by the QA image; the browser is the one the QA image links.
const playwright = createRequire("/usr/local/lib/node_modules/")("playwright") as typeof import("playwright");
const CARD = pathToFileURL("/video-tools/cards/card.html").href;
const FPS = 30;
const safe = (id: string) => id.replace(/[^A-Za-z0-9_-]/g, "_");

const browser = await playwright.chromium.launch({ executablePath: "/usr/local/bin/chromium-qa", args: ["--no-sandbox", "--disable-gpu"] });
try {
  for (const scene of timeline.scenes.filter((s) => s.kind === "card")) {
    const clip = narration.scenes.find((n) => n.id === scene.id)?.durationS ?? 0;
    // The same length compose-plan gives the card: its slot, or its clip plus 0.3 s.
    const durationS = round3(Math.max(scene.end - scene.start, clip + 0.3));
    const card = scene.card ?? { heading: scene.title, role: "chapter" as const };
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    await page.addInitScript((c) => ((window as unknown as { __CARD__: unknown }).__CARD__ = c), { id: scene.id, ...card, durationS });
    await page.goto(CARD);
    await page.waitForFunction(() => (window as unknown as { READY?: boolean }).READY === true);
    const frames = join(out, `frames-${safe(scene.id)}`);
    mkdirSync(frames, { recursive: true });
    const count = Math.ceil(durationS * FPS);
    for (let i = 0; i < count; i++) {
      await page.evaluate((t) => (window as unknown as { seek(t: number): void }).seek(t), i / FPS);
      await page.screenshot({ path: join(frames, `${String(i).padStart(5, "0")}.png`) });
    }
    await page.close();
    await mustRun("ffmpeg", ["-y", "-v", "error", "-framerate", String(FPS), "-i", join(frames, "%05d.png"), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", String(FPS), join(out, `card-${safe(scene.id)}.mp4`)]);
    rmSync(frames, { recursive: true, force: true });
    console.log(`card ${scene.id}: ${count} frames`);
  }
} finally {
  await browser.close();
}
