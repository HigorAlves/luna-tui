// The demo fixture: what the recorder's Playwright specs import to pace a demo to the voice.
//   import { narration } from "/video-tools/tools/fixture.ts";
//   const page = await context.newPage();
//   narration.startRecording(page);
//   narration.mark("add-coupon");
//   await page.waitForTimeout(narration.durationFor("add-coupon"));   // ms, from the clip's length
//   ...
//   await narration.finish(page);          // closes the page so the video is written, then writes timing.json
// The fixture has no dependency of its own: it takes the page it is given and uses only its API.
import { readFileSync, writeFileSync } from "node:fs";

const JOB = process.env.LUNA_JOB ?? "/work";
const NARRATION = process.env.LUNA_NARRATION ?? `${JOB}/narration/narration.json`;
const TIMING = process.env.LUNA_TIMING ?? `${JOB}/timing.json`;

type PageLike = {
  evaluate: (fn: (...a: never[]) => unknown, ...args: unknown[]) => Promise<unknown>;
  waitForTimeout: (ms: number) => Promise<void>;
  locator: (sel: string) => { first(): { boundingBox(): Promise<{ x: number; y: number; width: number; height: number } | null> } };
  mouse: { move(x: number, y: number, o?: { steps?: number }): Promise<void> };
  video: () => { path(): Promise<string> } | null;
  close: () => Promise<void>;
};

let t0 = 0;
const marks: { scene: string; t: number }[] = [];
let clips: Record<string, number> | null = null;

function clipLengths(): Record<string, number> {
  if (clips) return clips;
  const j = JSON.parse(readFileSync(NARRATION, "utf8")) as { scenes: { id: string; durationS: number }[] };
  clips = Object.fromEntries(j.scenes.map((s) => [s.id, s.durationS]));
  return clips;
}

function write(videoPath: string | null) {
  writeFileSync(TIMING, JSON.stringify({ marks, videoPath }, null, 2));
}

export const narration = {
  /** Call right after the page is created: the recording's clock starts here. */
  startRecording(_page: PageLike) {
    t0 = Date.now();
    marks.length = 0;
    write(null);
  },
  /** A scene begins now. */
  mark(scene: string) {
    marks.push({ scene, t: Math.round(((Date.now() - t0) / 1000) * 1000) / 1000 });
    write(null);
  },
  /** How long the scene's narration clip runs, in milliseconds: the time the demo should take. */
  durationFor(scene: string): number {
    const s = clipLengths()[scene];
    if (s === undefined) throw new Error(`no narration for scene "${scene}"`);
    return Math.round(s * 1000);
  },
  /** An on-screen caption for `ms`. */
  async caption(page: PageLike, text: string, ms: number) {
    await page.evaluate(((t: string) => {
      const el = document.createElement("div");
      el.id = "luna-caption";
      el.textContent = t;
      el.style.cssText = "position:fixed;left:50%;bottom:48px;transform:translateX(-50%);max-width:80%;padding:12px 22px;background:rgba(14,17,22,.88);color:#fff;font:600 28px/1.3 system-ui,sans-serif;border-radius:10px;z-index:2147483647";
      document.body.appendChild(el);
    }) as never, text);
    await page.waitForTimeout(ms);
    await page.evaluate((() => document.getElementById("luna-caption")?.remove()) as never);
  },
  /** A ring around the element for `ms`. */
  async highlight(page: PageLike, selector: string, ms: number) {
    await page.evaluate(((sel: string) => {
      const el = document.querySelector(sel) as HTMLElement | null;
      if (!el) return;
      el.dataset.lunaOutline = el.style.outline;
      el.style.outline = "4px solid #4da3ff";
      el.style.outlineOffset = "4px";
    }) as never, selector);
    await page.waitForTimeout(ms);
    await page.evaluate(((sel: string) => {
      const el = document.querySelector(sel) as HTMLElement | null;
      if (el) el.style.outline = el.dataset.lunaOutline ?? "";
    }) as never, selector);
  },
  /** A visible cursor glides to the element's centre. */
  async cursorTo(page: PageLike, selector: string) {
    const box = await page.locator(selector).first().boundingBox();
    if (!box) return;
    await page.evaluate((() => {
      if (document.getElementById("luna-cursor")) return;
      const c = document.createElement("div");
      c.id = "luna-cursor";
      c.style.cssText = "position:fixed;width:22px;height:22px;border-radius:50%;background:rgba(77,163,255,.85);border:2px solid #fff;pointer-events:none;z-index:2147483647;transform:translate(-50%,-50%)";
      document.body.appendChild(c);
      document.addEventListener("mousemove", (e) => {
        c.style.left = e.clientX + "px";
        c.style.top = e.clientY + "px";
      });
    }) as never);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 24 });
  },
  /** Close the page so Playwright writes the video, then write timing.json with its path. */
  async finish(page: PageLike) {
    const video = page.video();
    await page.close();
    write(video ? await video.path() : null);
  },
};
