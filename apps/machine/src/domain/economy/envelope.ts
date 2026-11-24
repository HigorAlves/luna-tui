// A pack's envelope in a repository: how many tool calls a run of it that passed usually took, with a margin. The loop guard stops a run
// only past it. Percentile and margin are TokenEconomizer's (te-spec §1.3): linear interpolation, p90, times 1.25, none under the minimum.

/** The samples kept per repository and pack: the last this many passing runs. */
export const ENVELOPE_KEEP = 500;
const PERCENTILE = 90;
const MARGIN = 1.25;

/** The samples with one more, the last `ENVELOPE_KEEP` of them. */
export function addSample(samples: number[], calls: number): number[] {
  return [...samples, calls].slice(-ENVELOPE_KEEP);
}

/** Linear-interpolated percentile of an unsorted list (0 <= p <= 100). */
function percentile(values: number[], p: number): number {
  const xs = [...values].sort((a, b) => a - b);
  if (xs.length === 1) return xs[0]!;
  const i = (p / 100) * (xs.length - 1);
  const lo = Math.floor(i);
  if (lo + 1 >= xs.length) return xs[xs.length - 1]!;
  return xs[lo]! + (i - lo) * (xs[lo + 1]! - xs[lo]!);
}

/** The calls past which a run of the pack is looping, or null before there are `minSamples` passing runs. */
export function envelopeOf(samples: number[], minSamples: number): number | null {
  if (samples.length === 0 || samples.length < minSamples) return null;
  return percentile(samples, PERCENTILE) * MARGIN;
}
