import { describe, expect, it } from "vitest";

import { type BuildLimits, buildBudget, rateLimitWaitMs } from "./build-budget.ts";

const limits: BuildLimits = { max_iterations: 15, max_tokens: 2_000_000, max_minutes: 90, backoff_minutes: [1, 30], regression_full_suite_minutes: 10 };
const at = (minute: number) => new Date(Date.UTC(2026, 10, 5, 12, minute));
const run = (stage: string, from: number, to: number | null) => ({ stage, startedAt: at(from), endedAt: to === null ? null : at(to) });
const row = (kind: string, payload: Record<string, unknown> = {}) => ({ kind, payload });
const finished = (tokens?: { input: number; output: number }) => row("stage.finished", { stage: "implementing", ...(tokens ? { tokens } : {}) });

describe("buildBudget", () => {
  it("counts each red and green the ledger reported, the tokens of every implementing run (input plus output) and their minutes", () => {
    const budget = buildBudget(
      [run("implementing", 0, 20), run("implementing", 30, 40), run("verifying", 50, 55)],
      [row("stage.slice.red"), row("stage.slice.green"), row("stage.slice.committed"), finished({ input: 100_000, output: 20_000 }), row("stage.slice.red"), finished({ input: 50_000, output: 5_000 }), row("stage.slice.green", {})],
      limits,
    );
    // 2 reds + 2 greens; tokens 120,000 + 55,000; minutes 20 + 10 (the verifying run is not Build's).
    expect(budget).toMatchObject({ iterations: 4, tokens: 175_000, tokensCounted: true, minutes: 30, spent: null });
    expect(budget.minutesLeft).toBe(60);
  });

  it("says tokens are not counted when no run reported them, and never spends the token limit then", () => {
    const budget = buildBudget([run("implementing", 0, 10)], [finished()], limits);
    expect(budget).toMatchObject({ tokens: null, tokensCounted: false, spent: null });
  });

  it("is spent on the 16th iteration, on tokens past the limit and on minutes past the limit, naming which and the numbers", () => {
    const sixteen = Array.from({ length: 16 }, (_, i) => row(i % 2 ? "stage.slice.green" : "stage.slice.red"));
    expect(buildBudget([run("implementing", 0, 1)], sixteen.slice(0, 15), limits).spent).toBeNull();
    expect(buildBudget([run("implementing", 0, 1)], sixteen, limits)).toMatchObject({ spent: "iterations", iterations: 16 });
    expect(buildBudget([run("implementing", 0, 1)], [finished({ input: 1_900_000, output: 100_001 })], limits)).toMatchObject({ spent: "tokens", tokens: 2_000_001 });
    expect(buildBudget([run("implementing", 0, 91)], [], limits)).toMatchObject({ spent: "minutes", minutes: 91, minutesLeft: 0 });
  });

  it("counts a running run's time up to now, and the consecutive reds at the end of the ledger's story", () => {
    const now = at(35);
    const budget = buildBudget([run("implementing", 0, 10), run("implementing", 20, null)], [row("stage.slice.red"), row("stage.slice.green"), row("stage.slice.red"), row("stage.slice.red")], limits, now);
    expect(budget).toMatchObject({ minutes: 25, consecutiveReds: 2 });
  });

  it("counts a failed regression sweep as an iteration", () => {
    expect(buildBudget([run("implementing", 0, 1)], [row("build.sweep_failed"), row("build.sweep_failed")], limits).iterations).toBe(2);
  });
});

describe("the machine's own count of iterations", () => {
  it("counts every implementing run and every failed sweep as an iteration whatever the ledger says, and takes the larger of the two counts", () => {
    const runs = Array.from({ length: 16 }, (_, i) => run("implementing", i, i));
    const rows = runs.map(() => finished());
    // The ledger (a file the agent writes) reports nothing: the machine's own rows still spend the card.
    expect(buildBudget(runs, rows, limits)).toMatchObject({ iterations: 16, spent: "iterations" });
    // A ledger that reports more than the rows wins.
    expect(buildBudget([run("implementing", 0, 1)], [finished(), row("stage.slice.red"), row("stage.slice.green"), row("stage.slice.red")], limits).iterations).toBe(3);
    // Sweep failures count as machine rows too.
    expect(buildBudget([run("implementing", 0, 1)], [finished(), row("build.sweep_failed"), row("build.sweep_failed")], limits).iterations).toBe(3);
  });
});

describe("rateLimitWaitMs", () => {
  const now = Date.UTC(2026, 10, 5, 12, 0);
  it("waits for the provider's reset, at least 1 minute and at most 30", () => {
    expect(rateLimitWaitMs(now / 1000 + 600, limits, now)).toBe(10 * 60_000);
    expect(rateLimitWaitMs(now / 1000 + 5, limits, now)).toBe(60_000);
    expect(rateLimitWaitMs(now / 1000 + 6 * 3600, limits, now)).toBe(30 * 60_000);
  });
  it("takes the lower bound when the provider gave no reset time", () => {
    expect(rateLimitWaitMs(null, limits, now)).toBe(60_000);
  });
});
