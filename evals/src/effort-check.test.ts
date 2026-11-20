import type { StageOutput } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import { IGNORED_EFFORT, effortProblems, honourEffort, visionProblems } from "./effort-check.ts";
import type { CaseResult } from "./grade.ts";

const output = (effort?: string) => ({ ok: true, run: { runtime: "claude", engine: "claude:haiku", modelId: "m", ...(effort ? { effort } : {}), sdk: { name: "s", version: "1" }, fingerprint: "0".repeat(64) } }) as unknown as StageOutput;
const passing = (): CaseResult => ({ id: "c", pass: true, schema: { check: "schema", pass: true, detail: null }, checks: [], judge: null, turns: 1, durationMs: 1, costUsd: null, model: null });

describe("honourEffort", () => {
  it("leaves a run alone when no effort was asked for", () => {
    const result = passing();
    expect(honourEffort(undefined, output(), result)).toEqual({ result, ignored: false });
  });

  it("leaves a run alone when it ran at the effort asked for", () => {
    const result = passing();
    expect(honourEffort("low", output("low"), result)).toEqual({ result, ignored: false });
  });

  it("fails the case when the run's effort differs", () => {
    const { result, ignored } = honourEffort("low", output("high"), passing());
    expect(ignored).toBe(true);
    expect(result.pass).toBe(false);
    expect(result.checks.at(-1)).toEqual({ check: "run.effort is low", pass: false, detail: `${IGNORED_EFFORT} (ran at high)` });
  });

  it("fails the case when the run reports no effort (an old image strips the key)", () => {
    const { result, ignored } = honourEffort("low", output(), passing());
    expect(ignored).toBe(true);
    expect(result.pass).toBe(false);
    expect(result.checks.at(-1)!.detail).toBe(`${IGNORED_EFFORT} (reported none)`);
  });

  it("says nothing about a run that left no output: it already fails", () => {
    const result = passing();
    expect(honourEffort("low", null, result)).toEqual({ result, ignored: false });
  });

  it("names the rebuild in the message", () => {
    expect(IGNORED_EFFORT).toBe("the runner image does not honour --effort: rebuild it (pnpm images)");
  });
});

describe("effortProblems", () => {
  it("is null when no effort was asked for", () => {
    expect(effortProblems("risk_score", ["jev"], undefined)).toBeNull();
  });

  it("refuses a decision pack with an effort, naming the engine", () => {
    expect(effortProblems("risk_score", ["jev"], "low")).toBe("jev: risk_score is a decision pack and takes no effort");
  });

  it("checks every engine, --against included, and names the first that cannot run the effort", () => {
    expect(effortProblems("plan", ["claude:opus", "claude:haiku"], "low")).toBeNull();
    expect(effortProblems("plan", ["claude:opus", "jev"], "low")).toBe("jev: jev does not support effort low (supports: none)");
  });
});

describe("visionProblems", () => {
  it("names the first engine that cannot read images for a pack that needs them", () => {
    expect(visionProblems("design_parity", ["claude:opus", "codex:luna"])).toBe("codex:luna cannot read images, which design_parity needs");
  });
  it("lets a pack that needs no images run on any engine", () => {
    expect(visionProblems("triage", ["codex:luna"])).toBeNull();
  });
});
