// The text read off a film's frames and a PR's screenshots, checked for what must not be published (the shared list in `runner-video/tools/lib/findings.ts`). Pure. A hit is a place and a kind, never the matched text: it ends up in a fix card, a note and an event.
import { type FindingKind, findingKinds } from "../../runner-video/tools/lib/findings.ts";

export interface ScreenFrame {
  /** Seconds into the film. */
  t?: number;
  /** A screenshot's file name, or `transcript`. */
  file?: string;
  text: string;
  /** What the frames tool found in the whole text, which `text` may be cut from. */
  kinds?: readonly FindingKind[];
}
export interface ScreenHit {
  place: string;
  kind: FindingKind;
}

export function screenFindings(frames: readonly ScreenFrame[]): ScreenHit[] {
  return frames.flatMap((f) => {
    const place = f.file !== undefined ? f.file : `${f.t ?? 0} s`;
    return [...new Set([...findingKinds(f.text), ...(f.kinds ?? [])])].map((kind) => ({ place, kind }));
  });
}
