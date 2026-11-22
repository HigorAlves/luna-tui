import { describe, expect, it, vi } from "vitest";

import type { StageContext, StageResult } from "../ports.ts";
import { designRun } from "./design-run.ts";

const budget = (spent: "tokens" | "minutes" | null) => ({ tokens: 10, tokensCounted: true, minutes: 1, minutesLeft: 44, spent, limits: { max_tokens: 1_000_000, max_minutes: 45 } });
const ctx = (emitted: Array<[string, Record<string, unknown>]>) => ({ task: { id: "t1" }, emit: async (k: string, p: Record<string, unknown>) => void emitted.push([k, p]) }) as unknown as StageContext;
const passing: StageResult = { outcome: "pass", detail: { answer: {} }, usage: { turns: 3, costUsd: 0.1, tokens: { input: 1000, output: 200, cached: 0 } } };

describe("designRun", () => {
  it("runs the pack, logs one design.run row with its tokens and minutes, and reads the budget again after", async () => {
    const emitted: Array<[string, Record<string, unknown>]> = [];
    const times = [0, 90_000];
    const reads = vi.fn().mockResolvedValueOnce(budget(null)).mockResolvedValueOnce(budget("tokens"));
    const out = await designRun({ budget: reads, now: () => times.shift()! }, ctx(emitted), "design_spec", async () => passing);
    expect(out).toEqual({ result: passing, spentAfter: true });
    expect(emitted).toEqual([["design.run", { pack: "design_spec", tokens: 1200, minutes: 1.5, outcome: "pass" }]]);
  });
  it("starts no run on a spent budget: it escalates design_budget with the numbers", async () => {
    const run = vi.fn();
    const out = await designRun({ budget: async () => budget("minutes") }, ctx([]), "a11y_audit", run);
    expect(run).not.toHaveBeenCalled();
    expect(out.result).toMatchObject({ outcome: "escalated", detail: { escalation: "design_budget", reason: expect.stringContaining("design budget is spent"), designBudget: { spent: "minutes" } } });
  });
  it("runs with no budget port (tests, a machine built without one) and logs tokens as null when the runtime counted none", async () => {
    const emitted: Array<[string, Record<string, unknown>]> = [];
    await designRun({}, ctx(emitted), "design_spec", async () => ({ outcome: "fail", detail: {} }));
    expect(emitted[0]![1]).toMatchObject({ tokens: null, outcome: "fail" });
  });
});
