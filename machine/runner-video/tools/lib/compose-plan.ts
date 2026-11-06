// How the film is cut together: which stretch of the recording or which card clip plays in each
// scene, where each narration clip lands, the chapters, and the ffmpeg arguments that do it. Pure:
// the tool runs ffmpeg, this only decides what to ask of it.
import type { Timeline } from "./timeline.ts";

export type Narration = { scenes: { id: string; wav: string; durationS: number }[] };
export type Timing = { marks: { scene: string; t: number }[]; videoPath: string; durationS?: number };
export type Segment = { scene: string; source: "card" | "recording"; from: number; to: number; holdS: number };
export type ComposePlan = {
  format: { w: number; h: number; fps: number };
  segments: Segment[];
  audio: { scene: string; wav: string; atS: number }[];
  chapters: { title: string; startS: number }[];
  totalS: number;
};

/** A recorded stretch longer than its narration clip by more than this is cut to the clip plus this. */
export const TRIM_SLACK_S = 1;
const GAP_S = 0.1;
const CARD_PAD_S = 0.3;
const r3 = (n: number) => Math.round(n * 1000) / 1000;

export function composePlan(tl: Timeline, narration: Narration, timing: Timing): ComposePlan {
  const clips = new Map(narration.scenes.map((s) => [s.id, s]));
  const marks = [...timing.marks].sort((a, b) => a.t - b.t);
  const plan: ComposePlan = { format: { w: tl.meta.w, h: tl.meta.h, fps: tl.meta.fps }, segments: [], audio: [], chapters: [], totalS: 0 };
  let at = 0;
  let lastAudioEnd = -Infinity;
  for (const scene of tl.scenes) {
    const clip = clips.get(scene.id);
    if (!clip) throw new Error(`no narration for scene "${scene.id}"`);
    let seg: Segment;
    if (scene.kind === "card") {
      seg = { scene: scene.id, source: "card", from: 0, to: r3(Math.max(scene.end - scene.start, clip.durationS + CARD_PAD_S)), holdS: 0 };
    } else {
      const i = marks.findIndex((m) => m.scene === scene.id);
      if (i < 0) throw new Error(`no mark for demo scene "${scene.id}"`);
      const from = marks[i]!.t;
      const end = marks[i + 1]?.t ?? timing.durationS ?? from + clip.durationS;
      // Shorter than the clip: hold the last frame. Longer by more than the slack: cut to the clip plus the slack (D6).
      const to = end - from > clip.durationS + TRIM_SLACK_S ? from + clip.durationS + TRIM_SLACK_S : end;
      seg = { scene: scene.id, source: "recording", from, to: r3(to), holdS: r3(Math.max(0, clip.durationS - (to - from))) };
    }
    const length = seg.source === "card" ? seg.to : r3(seg.to - seg.from + seg.holdS);
    const atS = r3(Math.max(at, lastAudioEnd + GAP_S));
    lastAudioEnd = atS + clip.durationS;
    plan.segments.push(seg);
    plan.audio.push({ scene: scene.id, wav: clip.wav, atS });
    plan.chapters.push({ title: scene.title, startS: r3(at) });
    at = r3(at + length);
  }
  plan.totalS = at;
  return plan;
}

export type FfmpegOpts = {
  recording: string;
  cards: Record<string, string>;
  out: string;
  captions?: string;
  fontSize: number;
  /** An ffmetadata file (see chaptersMetadata), written by the caller. */
  metadata?: string;
};

const escFilterPath = (p: string) => p.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");

export function ffmpegArgs(plan: ComposePlan, o: FfmpegOpts): string[] {
  const inputs: string[] = [o.recording];
  const cardIndex = new Map<string, number>();
  for (const seg of plan.segments) {
    if (seg.source !== "card") continue;
    const clip = o.cards[seg.scene];
    if (!clip) throw new Error(`no card clip for scene "${seg.scene}"`);
    cardIndex.set(seg.scene, inputs.length);
    inputs.push(clip);
  }
  const wavIndex = new Map<string, number>();
  for (const a of plan.audio) {
    wavIndex.set(a.scene, inputs.length);
    inputs.push(a.wav);
  }
  const metaIndex = o.metadata ? inputs.length : -1;
  if (o.metadata) inputs.push(o.metadata);

  const { w, h, fps } = plan.format;
  const norm = `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,fps=${fps},setsar=1,format=yuv420p`;
  const parts: string[] = [];
  for (const seg of plan.segments) {
    if (seg.source === "card") {
      parts.push(`[${cardIndex.get(seg.scene)}:v]tpad=stop_mode=clone:stop_duration=${seg.to},trim=duration=${seg.to},setpts=PTS-STARTPTS,${norm}[v_${seg.scene}]`);
    } else {
      const hold = seg.holdS > 0 ? `,tpad=stop_mode=clone:stop_duration=${seg.holdS}` : "";
      parts.push(`[0:v]trim=start=${seg.from}:end=${seg.to},setpts=PTS-STARTPTS${hold},${norm}[v_${seg.scene}]`);
    }
  }
  parts.push(`${plan.segments.map((s) => `[v_${s.scene}]`).join("")}concat=n=${plan.segments.length}:v=1:a=0[vc]`);
  const style = `force_style='FontSize=${o.fontSize}'`;
  parts.push(o.captions ? `[vc]subtitles='${escFilterPath(o.captions)}':${style}[vout]` : "[vc]null[vout]");
  for (const a of plan.audio) parts.push(`[${wavIndex.get(a.scene)}:a]adelay=${Math.round(a.atS * 1000)}:all=1[a_${a.scene}]`);
  parts.push(`${plan.audio.map((a) => `[a_${a.scene}]`).join("")}amix=inputs=${plan.audio.length}:normalize=0:duration=longest[am]`);
  parts.push("[am]loudnorm=I=-14:TP=-1:LRA=11[aout]");

  return [
    "-y",
    ...inputs.flatMap((i) => ["-i", i]),
    "-filter_complex",
    parts.join(";"),
    "-map",
    "[vout]",
    "-map",
    "[aout]",
    ...(metaIndex >= 0 ? ["-map_metadata", String(metaIndex)] : []),
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "20",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-movflags",
    "+faststart",
    o.out,
  ];
}

const escMeta = (s: string) => s.replace(/[=;#\\\n]/g, (c) => (c === "\n" ? "\\\n" : `\\${c}`));

/** The ffmetadata file that gives the film its chapters. */
export function chaptersMetadata(plan: ComposePlan): string {
  const body = plan.chapters.map((c, i) => {
    const end = plan.chapters[i + 1]?.startS ?? plan.totalS;
    return `[CHAPTER]\nTIMEBASE=1/1000\nSTART=${Math.round(c.startS * 1000)}\nEND=${Math.round(end * 1000)}\ntitle=${escMeta(c.title)}\n`;
  });
  return `;FFMETADATA1\n${body.join("")}`;
}
