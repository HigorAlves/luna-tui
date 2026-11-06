// Which moments of a film are read for text, and how a frame's text is kept. Pure: the tool runs ffmpeg and tesseract.

export const MAX_FRAMES = 150;
export const MAX_TEXT = 4000;
const STEP_S = 2;
const AFTER_SCENE_START_S = 0.3;

const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** A frame every 2 s and 0.3 s after each scene start, sorted, none at or past the end; at most 150, thinned evenly. */
export function sampleTimes(sceneStarts: readonly number[], durationS: number): number[] {
  if (!(durationS > 0)) return [];
  const all = new Set<number>();
  for (let t = 0; t < durationS; t += STEP_S) all.add(r3(t));
  for (const s of sceneStarts) {
    const t = r3(s + AFTER_SCENE_START_S);
    if (t >= 0 && t < durationS) all.add(t);
  }
  const sorted = [...all].sort((a, b) => a - b);
  if (sorted.length <= MAX_FRAMES) return sorted;
  return Array.from({ length: MAX_FRAMES }, (_, i) => sorted[Math.floor((i * sorted.length) / MAX_FRAMES)]!);
}

/** A frame's text as it is written to frames.json: no control characters (a newline stays), at most 4000 characters. */
export function clampText(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "").slice(0, MAX_TEXT);
}
