// Build's budget for one card, read from what the machine already records: the implementing runs (their minutes) and the rows of the stream
// (each red or green the ledger reported, each failed regression sweep, the tokens a finished run reports). Tokens come from the runtime's own
// count on the finish row, never from a model's text; a runtime that cannot count leaves them out and the budget says they are not counted. Pure.
import type { FactoryConfig } from "@hardness/contracts";

export type BuildLimits = FactoryConfig["build"];

export interface BuildBudget {
  /** Each red or green the ledger reported after the tests commit, and each failed regression sweep. */
  iterations: number;
  /** Input plus output of every implementing run that reported them; null when none did. */
  tokens: number | null;
  tokensCounted: boolean;
  /** The implementing runs' wall-clock minutes, a running one counted up to `now`. */
  minutes: number;
  minutesLeft: number;
  /** Reds at the end of the ledger's story with no green or commit since. */
  consecutiveReds: number;
  limits: BuildLimits;
  /** Which limit is spent, or null. */
  spent: "iterations" | "tokens" | "minutes" | null;
}

interface RunFacts {
  stage: string;
  startedAt: Date;
  endedAt: Date | null;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

export function buildBudget(runs: readonly RunFacts[], events: readonly { kind: string; payload: Record<string, unknown> }[], limits: BuildLimits, now: Date = new Date()): BuildBudget {
  const mine = runs.filter((r) => r.stage === "implementing");
  const minutes = round1(mine.reduce((sum, r) => sum + ((r.endedAt ?? now).getTime() - r.startedAt.getTime()) / 60_000, 0));
  let ledgerIterations = 0;
  let machineIterations = 0;
  let consecutiveReds = 0;
  let tokens: number | null = null;
  for (const { kind, payload } of events) {
    if (kind === "stage.slice.red") {
      ledgerIterations += 1;
      consecutiveReds += 1;
    } else if (kind === "stage.slice.green") {
      ledgerIterations += 1;
      consecutiveReds = 0;
    } else if (kind === "stage.slice.committed") {
      consecutiveReds = 0;
    } else if (kind === "build.sweep_failed") {
      ledgerIterations += 1;
      machineIterations += 1;
    } else if (kind === "stage.finished" && payload.stage === "implementing") {
      machineIterations += 1;
      const t = payload.tokens as { input?: unknown; output?: unknown } | undefined;
      if (t && typeof t.input === "number" && typeof t.output === "number") tokens = (tokens ?? 0) + t.input + t.output;
    }
  }
  // The ledger is a file the agent writes: the machine's own rows (each implementing run, each failed sweep) count too, and the larger count stands.
  const iterations = Math.max(ledgerIterations, machineIterations);
  const minutesLeft = Math.max(0, round1(limits.max_minutes - minutes));
  const spent = iterations > limits.max_iterations ? "iterations" : tokens !== null && tokens > limits.max_tokens ? "tokens" : minutes > limits.max_minutes ? "minutes" : null;
  return { iterations, tokens, tokensCounted: tokens !== null, minutes, minutesLeft, consecutiveReds, limits, spent };
}

/** How long to wait for a provider's rate limit: until its reset (epoch seconds), clamped to `build.backoff_minutes` [low, high]; the low bound without one. */
export function rateLimitWaitMs(resetsAtSeconds: number | null, limits: BuildLimits, now: number = Date.now()): number {
  const [low, high] = limits.backoff_minutes;
  const wanted = resetsAtSeconds === null ? 0 : resetsAtSeconds * 1000 - now;
  return Math.min(high * 60_000, Math.max(low * 60_000, wanted));
}

/** The rows Build's budget counts: all of them, or only those after the last `build.budget_reset` (the stronger model's one run starts a fresh budget, counted from its own start). */
export function budgetRowsOf<R extends { startedAt: Date }, E extends { kind: string; at: Date }>(runs: readonly R[], events: readonly E[]): { runs: R[]; events: E[] } {
  const at = events.findLastIndex((e) => e.kind === "build.budget_reset");
  if (at < 0) return { runs: [...runs], events: [...events] };
  const since = events[at]!.at;
  return { runs: runs.filter((r) => r.startedAt >= since), events: events.slice(at + 1) };
}
