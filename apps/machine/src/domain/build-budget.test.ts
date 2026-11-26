import { describe, expect, it } from "vitest";

import { type BuildLimits, buildBudget, rateLimitWaitMs, scaledBuildLimits } from "./build-budget.ts";

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

  it("never counts the ui-designer's rows: a card with a helper's reds, greens and tokens has the Build budget of one without (RFC 0013, risk 5)", () => {
    const mine = [row("stage.slice.red", { id: 1 }), row("stage.slice.green", { id: 1 }), finished({ input: 100, output: 20 })];
    const helper = [row("stage.slice.red", { id: 2, by: "ui-designer" }), row("stage.slice.red", { id: 2, by: "ui-designer" }), row("stage.slice.green", { id: 2, by: "ui-designer" }), row("stage.slice.committed", { id: 2, by: "ui-designer" }), row("build.helper_ended", { slice: 2, attempt: 1, outcome: "pass", tokens: 900_000, minutes: 40 })];
    const runs = [run("implementing", 0, 10)];
    expect(buildBudget(runs, [...mine.slice(0, 2), ...helper, mine[2]!], limits)).toEqual(buildBudget(runs, mine, limits));
    // The consecutive-reds streak is the implementer's too: a helper's reds do not extend it, and its green does not break it.
    expect(buildBudget(runs, [row("stage.slice.red", { id: 1 }), ...helper, row("stage.slice.red", { id: 1 })], limits).consecutiveReds).toBe(2);
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

describe("a bounce that changed nothing", () => {
  const impl = (commit: string, outcome = "pass") => row("stage.finished", { stage: "implementing", outcome, detail: { env: { commit } } });
  const verifyFailed = () => row("stage.finished", { stage: "verifying", outcome: "fail" });
  const runs = (n: number) => Array.from({ length: n }, (_, i) => run("implementing", i, i));

  it("is not an iteration: an implementing run that passed on the same commit after a verify failure did nothing the budget should charge for", () => {
    const rows = [impl("c1"), verifyFailed(), impl("c1"), verifyFailed(), impl("c1")];
    expect(buildBudget(runs(3), rows, limits).iterations).toBe(1);
  });

  it("still counts a run that moved the commit, one that did not pass, and one that was not entered from a verify failure", () => {
    expect(buildBudget(runs(2), [impl("c1"), verifyFailed(), impl("c2")], limits).iterations).toBe(2);
    expect(buildBudget(runs(2), [impl("c1"), verifyFailed(), impl("c1", "fail")], limits).iterations).toBe(2);
    // A stuck agent that never commits, with nothing failing in Verify between its runs, still spends the card.
    expect(buildBudget(runs(3), [impl("c1"), impl("c1"), impl("c1")], limits).iterations).toBe(3);
  });

  it("counts a run whose commit is unknown", () => {
    expect(buildBudget(runs(2), [row("stage.finished", { stage: "implementing", outcome: "pass" }), verifyFailed(), row("stage.finished", { stage: "implementing", outcome: "pass" })], limits).iterations).toBe(2);
  });

  it("keeps the tokens and the minutes of the run it does not count", () => {
    const rows = [impl("c1"), verifyFailed(), row("stage.finished", { stage: "implementing", outcome: "pass", tokens: { input: 10, output: 5 }, detail: { env: { commit: "c1" } } })];
    expect(buildBudget(runs(2), rows, limits)).toMatchObject({ iterations: 1, tokens: 15 });
  });
});

describe("numbers read from rows", () => {
  it("ignores a token count that is not a non-negative integer: a forged negative one cannot hide what was spent", () => {
    const budget = buildBudget([run("implementing", 0, 1)], [finished({ input: -9_000_000, output: 1 }), finished({ input: 1.5, output: 1 }), finished({ input: 1_900_000, output: 100_001 })], limits);
    expect(budget).toMatchObject({ tokens: 2_000_001, spent: "tokens" });
    expect(buildBudget([run("implementing", 0, 1)], [finished({ input: -1, output: 1 })], limits)).toMatchObject({ tokens: null, tokensCounted: false });
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

describe("scaledBuildLimits: Build's budget grows with the plan's slices", () => {
  const defaults = limits;
  it("gives each slice three iterations, twenty minutes and 400k tokens, above the repo's limits (DISC-53: 13 slices against 15 iterations)", () => {
    const scaled = scaledBuildLimits(defaults, 13);
    expect(scaled.max_iterations).toBe(39);
    expect(scaled.max_minutes).toBe(260);
    expect(scaled.max_tokens).toBe(5_200_000);
    expect(scaled.backoff_minutes).toEqual(defaults.backoff_minutes);
  });
  it("never lowers a limit: a small plan, or a repo that set more, keeps its own", () => {
    expect(scaledBuildLimits(defaults, 2)).toEqual(defaults);
    expect(scaledBuildLimits(defaults, 0)).toEqual(defaults);
    const generous = { ...defaults, max_iterations: 100, max_minutes: 600, max_tokens: 9_000_000 };
    expect(scaledBuildLimits(generous, 13)).toEqual(generous);
  });
});
