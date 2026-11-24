// Caption cues from word timestamps, and their SubRip and WebVTT forms. Pure.

export type Word = { w: string; t0: number; t1: number };
export type Cue = { from: number; to: number; text: string };

const MIN_CUE_S = 0.6;
const BREAK = /[.!?;:,]$/;

/** Cues split at punctuation, or before a word would pass the character or duration cap. */
export function cuesFrom(words: Word[], opts: { maxChars: number; maxDurS: number }): Cue[] {
  const cues: Cue[] = [];
  let cur: Word[] = [];
  const flush = () => {
    if (cur.length === 0) return;
    const from = cur[0]!.t0;
    const to = Math.max(cur[cur.length - 1]!.t1, from + MIN_CUE_S);
    cues.push({ from: round(from), to: round(to), text: cur.map((x) => x.w).join(" ") });
    cur = [];
  };
  for (const word of words) {
    if (cur.length > 0) {
      const text = [...cur, word].map((x) => x.w).join(" ");
      if (text.length > opts.maxChars || word.t1 - cur[0]!.t0 > opts.maxDurS) flush();
    }
    cur.push(word);
    if (BREAK.test(word.w)) flush();
  }
  flush();
  return cues;
}
const round = (n: number) => Math.round(n * 1000) / 1000;

function stamp(s: number, sep: "," | "."): string {
  const ms = Math.round(s * 1000);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const sec = Math.floor((ms % 60_000) / 1000);
  const pad = (n: number, l = 2) => String(n).padStart(l, "0");
  return `${pad(h)}:${pad(m)}:${pad(sec)}${sep}${pad(ms % 1000, 3)}`;
}

export function toSrt(cues: Cue[]): string {
  return cues.map((c, i) => `${i + 1}\n${stamp(c.from, ",")} --> ${stamp(c.to, ",")}\n${c.text}\n`).join("\n");
}

export function toVtt(cues: Cue[]): string {
  return `WEBVTT\n\n${cues.map((c) => `${stamp(c.from, ".")} --> ${stamp(c.to, ".")}\n${c.text}\n`).join("\n")}`;
}
