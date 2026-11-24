// Change size, as a script (D3: a fact is a script). The size_estimate decision answers a place on
// a seven-level rubric; these functions turn that place into lines and say how a number stands
// against the limits of `luna.yaml`'s `size` section. Pure.
import type { FactoryConfig } from "./config-v22.ts";

/** Lines at each level of size_estimate's `est_loc` rubric, in its order. */
export const SIZE_LOC_ANCHORS = [50, 200, 500, 1000, 2000, 4000, 8000] as const;
/** Files at each level of its `est_files` rubric. */
export const SIZE_FILE_ANCHORS = [2, 5, 10, 25, 50] as const;

function interpolate(anchors: readonly number[], score: number, round: (n: number) => number): number {
  const at = Math.min(Math.max(Number.isFinite(score) ? score : 0, 0), anchors.length - 1);
  const low = Math.floor(at);
  const high = Math.min(low + 1, anchors.length - 1);
  const from = anchors[low]!;
  const to = anchors[high]!;
  return round(from * (to / from) ** (at - low));
}

/** Changed lines for a fractional `est_loc` score: log-scale between the two anchors around it, rounded to ten, clamped to the ends. */
export const locOf = (score: number): number => interpolate(SIZE_LOC_ANCHORS, score, (n) => Math.round(n / 10) * 10);
/** Files for a fractional `est_files` score, rounded to one. */
export const filesOf = (score: number): number => interpolate(SIZE_FILE_ANCHORS, score, Math.round);

export type SizeLimits = { target: [number, number]; hard: number; maxChildren: number; maxRounds: number; depth: number };

/** The five limits, read from a repository's `size` section; the target comes back sorted. */
export function sizeLimits(size: FactoryConfig["size"]): SizeLimits {
  const [a, b] = size.target_loc;
  return { target: [Math.min(a, b), Math.max(a, b)], hard: size.hard_limit_loc, maxChildren: size.max_children, maxRounds: size.max_rounds, depth: size.depth };
}

export type SizeVerdict = "over" | "over_target" | "within";

/** Above the hard limit is `over`; above the target's top, `over_target`; else `within`. Only `over` splits. */
export function sizeVerdict(estLoc: number, limits: Pick<SizeLimits, "target" | "hard">): SizeVerdict {
  if (estLoc > limits.hard) return "over";
  if (estLoc > limits.target[1]) return "over_target";
  return "within";
}
