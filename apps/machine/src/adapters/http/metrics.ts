// Factory metrics: how the pipeline is doing over a window. The query itself lives in
// ../persistence/metrics-query.ts; this file is the pure, DB-free helpers the HTTP layer and
// the query both use, plus parsing the `since` the API receives.
import type { Stats } from "@hardness/contracts";

const DAY_MS = 86_400_000;

export class InvalidSince extends Error {
  constructor(value: string) {
    super(`since must be like 7d, 30d or an ISO timestamp, got "${value}"`);
    this.name = "InvalidSince";
  }
}

/** `7d`, `30d` (any whole number of days) or an ISO timestamp. */
export function parseSince(value: string | undefined, now: Date = new Date()): Date {
  const raw = value ?? "7d";
  const days = /^(\d+)d$/.exec(raw);
  if (days) return new Date(now.getTime() - Number(days[1]) * DAY_MS);
  const at = /^\d{4}-\d{2}-\d{2}/.test(raw) ? new Date(raw) : new Date(Number.NaN);
  if (Number.isNaN(at.getTime())) throw new InvalidSince(raw);
  return at;
}

/** Linear interpolation between ranks, like Postgres `percentile_cont`. Null when empty. */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (sorted.length - 1) * p;
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  return sorted[low]! + (sorted[high]! - sorted[low]!) * (rank - low);
}

export const stats = (values: number[]): Stats => ({ median: percentile(values, 0.5), p90: percentile(values, 0.9) });
export const ratio = (part: number, whole: number): number | null => (whole === 0 ? null : part / whole);
