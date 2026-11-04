// The video's timeline: the contract between the script writer, the narration, the recorder and the
// composer, and the rules a film must meet before it is made. Pure: node and zod only, so the host
// tests it and the image runs it. The rules follow video-director's check_timeline, adapted to ours.
import { z } from "zod";

const Num = z.number().finite();

export const Scene = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "a scene id is letters, digits, _ or -, at most 64"),
  title: z.string(),
  kind: z.enum(["card", "demo"]),
  start: Num,
  end: Num,
  text: z.string(),
  card: z.object({ heading: z.string(), sub: z.string().optional(), role: z.enum(["hook", "chapter", "end"]) }).optional(),
  captions: z.array(z.object({ from: Num, to: Num, text: z.string() })).optional(),
});

export const TimelineText = z.object({
  role: z.enum(["hook", "cta", "term"]),
  text: z.string(),
  px: Num,
  from: Num,
  to: Num,
});

export const Timeline = z.object({
  meta: z.object({
    w: z.number().int().positive(),
    h: z.number().int().positive(),
    fps: z.number().positive(),
    dur: Num,
    clock: z.literal("voice"),
    title: z.string(),
    commit: z.string(),
  }),
  scenes: z.array(Scene).min(1),
  texts: z.array(TimelineText),
  terms: z.array(z.string()),
  facts: z.array(z.object({ claim: z.string(), source: z.string() })),
  vo: z.object({ status: z.enum(["ESTIMATED", "MEASURED"]) }).optional(),
});
export type Timeline = z.infer<typeof Timeline>;

export const MAX_DURATION_S = 240;
export const MIN_DURATION_S = 30;
export const HOOK_BY_S = 3.0;
const HOOK_PX = 84;
const OTHER_PX = 48;
const MAX_WORDS_PER_S = 3.0;

const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
const round = (n: number) => Math.round(n * 1000) / 1000;

/** The rules a timeline must meet. Errors block the film; warnings go to the critic. */
export function checkTimeline(tl: Timeline, opts: { scenarios: string[] }): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const frame = 1 / tl.meta.fps;
  const scenes = tl.scenes;

  if (Math.abs(scenes[0]!.start) > frame) errors.push(`the first scene "${scenes[0]!.id}" starts at ${scenes[0]!.start}s, not 0`);
  for (let i = 1; i < scenes.length; i++) {
    const gap = scenes[i]!.start - scenes[i - 1]!.end;
    if (Math.abs(gap) > frame) {
      errors.push(`scenes are not contiguous: ${gap > 0 ? "gap" : "overlap"} of ${round(Math.abs(gap))}s between "${scenes[i - 1]!.id}" and "${scenes[i]!.id}"`);
    }
  }
  const last = scenes[scenes.length - 1]!;
  if (Math.abs(last.end - tl.meta.dur) > frame) errors.push(`the last scene ends at ${last.end}s but meta.dur is ${tl.meta.dur}s`);
  for (const s of scenes) if (s.end <= s.start) errors.push(`scene "${s.id}" ends (${s.end}s) before it starts (${s.start}s)`);

  if (tl.meta.dur > MAX_DURATION_S) errors.push(`the film runs ${tl.meta.dur}s, over the ${MAX_DURATION_S}s limit`);
  else if (tl.meta.dur < MIN_DURATION_S) warnings.push(`the film runs ${tl.meta.dur}s, under ${MIN_DURATION_S}s`);

  const demoTitles = new Set(scenes.filter((s) => s.kind === "demo").map((s) => norm(s.title)));
  for (const sc of opts.scenarios) if (!demoTitles.has(norm(sc))) errors.push(`no demo scene for the approved scenario "${sc}"`);

  const hook = tl.texts.find((t) => t.role === "hook");
  if (!hook) errors.push(`no hook text: the film needs one on screen by ${HOOK_BY_S}s`);
  else if (hook.from > HOOK_BY_S) errors.push(`the hook text starts at ${hook.from}s, after ${HOOK_BY_S}s`);

  const scale = 1080 / Math.min(tl.meta.w, tl.meta.h);
  for (const t of tl.texts) {
    const floor = Math.round((t.role === "hook" ? HOOK_PX : OTHER_PX) * scale);
    if (t.px < floor) errors.push(`${t.role} text "${t.text}" is ${t.px}px, under the ${floor}px floor (84 for the hook, 48 otherwise at 1080)`);
    const need = Math.max(1.5, 1 + 0.3 * words(t.text));
    if (t.to - t.from < need) warnings.push(`${t.role} text "${t.text}" is on screen ${round(t.to - t.from)}s, under its read time of ${round(need)}s`);
  }

  for (const s of scenes) {
    const span = s.end - s.start;
    if (span > 0 && words(s.text) / span > MAX_WORDS_PER_S) warnings.push(`scene "${s.id}" narrates ${round(words(s.text) / span)} words/s, over ${MAX_WORDS_PER_S}`);
  }

  const claims = tl.facts.map((f) => f.claim);
  const onScreen = [...tl.texts.map((t) => t.text), ...scenes.flatMap((s) => (s.captions ?? []).map((c) => c.text))];
  for (const text of onScreen) {
    if (/SCHEMATIC|Example data/i.test(text)) continue;
    for (const n of text.match(/\d+(?:[.,]\d+)?/g) ?? []) {
      if (!claims.some((c) => c.includes(n))) errors.push(`the number "${n}" on screen ("${text}") has no fact citing it and no SCHEMATIC label`);
    }
  }

  if (tl.terms.length === 0) warnings.push("no terms: the film names none of the words it teaches");
  return { errors, warnings };
}
