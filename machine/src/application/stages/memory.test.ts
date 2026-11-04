import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { TaskRow } from "../../domain/task.ts";
import { memoryReviewRunner, withMemoryReview } from "./memory.ts";
import type { StageContext, StageResult } from "../ports.ts";

const context = { task: { id: "t1" } as unknown as TaskRow, stage: "reviewing_memory", attempt: 1, runId: "r1", approvals: [], signal: new AbortController().signal } as StageContext;

function setup(answer: Record<string, unknown> | undefined, markdown: string | null) {
  const stateDir = mkdtempSync(join(tmpdir(), "memory-"));
  const artifacts: NonNullable<StageResult["artifacts"]> = [];
  if (markdown !== null) {
    const path = join(stateDir, "rules.md");
    writeFileSync(path, markdown);
    artifacts.push({ kind: "rules", path, label: "rules.md", sha256: "x" });
  }
  const runPack = async (): Promise<StageResult> => ({
    outcome: "pass",
    detail: { summary: "s", ...(answer ? { answer } : {}) },
    artifacts,
  });
  return memoryReviewRunner({ runPack, stateDir });
}

describe("memory review", () => {
  it("shapes the approval's rules from the answer and the rules.md copy", async () => {
    const proposed = [{ rule: "Run pnpm verify", evidence: ["a"], scope: "repo" }];
    const result = await setup(
      { incidents: [1, 2], patterns: [1], proposedRules: proposed, calibration: { estLocBias: 1.4 } },
      "- Run pnpm verify\n",
    )(context);
    expect(result.outcome).toBe("pass");
    expect(result.detail?.rules).toEqual({
      markdown: "- Run pnpm verify\n",
      proposedRules: proposed,
      calibration: { estLocBias: 1.4 },
      incidents: 2,
      patterns: 1,
    });
  });

  it("reports rules null with a note when the pack found no patterns", async () => {
    const result = await setup({ incidents: [], patterns: [] }, null)(context);
    expect(result.outcome).toBe("pass");
    expect(result.detail?.rules).toBeNull();
    expect(result.detail?.note).toMatch(/no rules/);
  });

  it("passes a failed pack through untouched", async () => {
    const run = memoryReviewRunner({ runPack: async () => ({ outcome: "fail", detail: { error: "boom" } }), stateDir: "/x" });
    expect(await run(context)).toEqual({ outcome: "fail", detail: { error: "boom" } });
  });
});

describe("withMemoryReview", () => {
  const pass: StageResult = { outcome: "pass", detail: { shipped: true } };
  const memory = async (): Promise<StageResult> => ({ outcome: "pass", detail: { rules: { markdown: "- r\n" }, answer: { a: 1 } }, artifacts: [{ kind: "rules", path: "/p", label: "rules.md", sha256: "x" }] });
  const ctx = { ...context, stage: "shipping" } as StageContext;

  it("runs the retro as the reviewing_memory pack after a passing ship and merges its rules", async () => {
    const seen: string[] = [];
    const run = withMemoryReview(async () => pass, async (c) => (seen.push(c.stage), memory()));
    const result = await run(ctx);
    expect(seen).toEqual(["reviewing_memory"]);
    expect(result.detail).toMatchObject({ shipped: true, rules: { markdown: "- r\n" } });
    expect(result.artifacts).toHaveLength(1);
  });

  it("leaves a failed ship alone and never runs the retro", async () => {
    let ran = false;
    const failed: StageResult = { outcome: "fail", detail: { error: "x" } };
    const result = await withMemoryReview(async () => failed, async () => ((ran = true), memory()))(ctx);
    expect(result).toBe(failed);
    expect(ran).toBe(false);
  });

  it("opens the gate with rules null when the retro throws", async () => {
    const result = await withMemoryReview(async () => pass, async () => Promise.reject(new Error("docker down")))(ctx);
    expect(result.outcome).toBe("pass");
    expect(result.detail).toMatchObject({ shipped: true, rules: null, note: expect.stringMatching(/docker down/) });
  });
});

describe("the retro's worth_learning question", () => {
  const facts = { predicted: { size: "small", risk: "low", estLoc: 120 }, actual: { added: 30, removed: 5, retries: { verify: 0, e2e: 0, ci: 0, total: 0 }, escalations: 0, format: "text", durationMin: 20 }, runs: 8 };
  const rich = { ...context, task: { id: "t1", repoPath: "/repo" } as unknown as TaskRow } as StageContext;

  function wire(worth: Record<string, unknown> | Error, answer: Record<string, unknown> = { incidents: [], patterns: [] }, withFacts = true) {
    const stateDir = mkdtempSync(join(tmpdir(), "memory-"));
    const path = join(stateDir, "rules.md");
    writeFileSync(path, "- r\n");
    const calls: unknown[][] = [];
    const runPack = async (...args: unknown[]): Promise<StageResult> => {
      calls.push(args);
      return { outcome: "pass", detail: { answer }, artifacts: [{ kind: "rules", path, label: "rules.md", sha256: "x" }] };
    };
    const decide = async () => {
      if (worth instanceof Error) throw worth;
      return { worth };
    };
    return { run: memoryReviewRunner({ runPack, stateDir, decide, ...(withFacts ? { facts: async () => facts } : {}) }), calls };
  }

  it("skips the pack on a confident no: no rules, a note from the facts, the gate still opens", async () => {
    const { run, calls } = wire({ value: false, p: 0.05 });
    const result = await run(rich);
    expect(result).toMatchObject({ outcome: "pass", detail: { rules: null, note: "no retro: 0 retries, 0 escalations, 35 lines changed against 120 planned" } });
    expect(calls).toEqual([]);
  });

  it("runs the pack, with the facts as its context, on a yes, an unsure answer, a failed decision, and when the machine has no facts", async () => {
    for (const worth of [{ value: true, p: 0.9 }, { value: false, p: 0.45 }, new Error("no model")]) {
      const { run, calls } = wire(worth);
      expect((await run(rich)).detail?.rules).not.toBeNull();
      expect(calls[0]![1]).toEqual({ kind: "retro", retro: facts });
    }
    const none = wire({ value: false, p: 0.01 }, undefined, false);
    expect((await none.run(rich)).detail?.rules).not.toBeNull();
    expect(none.calls[0]![1]).toBeUndefined();
  });

  it("puts the recalibration, the graph misses and the prompt updates the pack answered into the rules", async () => {
    const recalibration = [{ dimension: "size", predicted: "small", actual: "large", note: "the export touched the auth layer" }];
    const promptUpdates = [{ pack: "implementing", change: "ask for the layer map first" }];
    const { run } = wire({ value: true, p: 0.9 }, { incidents: [], patterns: [], recalibration, graphMisses: ["src/auth.ts"], promptUpdates });
    expect((await run(rich)).detail?.rules).toMatchObject({ markdown: "- r\n", recalibration, graphMisses: ["src/auth.ts"], promptUpdates });
  });
});

describe("retroFactsOf", () => {
  it("sets what was predicted against what happened, from the task's own records", async () => {
    const { retroFactsOf } = await import("./memory.ts");
    const facts = retroFactsOf({
      task: { record: { size: "small", risk: "low" }, diffAdded: 300, diffRemoved: 40, retries: { verify: 1, e2e: 0, ci: 2, total: 3, stronger: 0 }, evidence: { format: "captures" }, createdAt: new Date("2026-11-04T10:00:00Z"), updatedAt: new Date("2026-11-04T11:35:00Z") } as unknown as TaskRow,
      ledger: { schema: 1, slices: [{ id: 1, title: "a", status: "committed", commit: "x", estLoc: 100 }, { id: 2, title: "b", status: "committed", commit: "y", estLoc: 20 }, { id: 3, title: "c", status: "committed", commit: "z" }] },
      events: [{ kind: "transition", payload: { to: "escalated" } }, { kind: "transition", payload: { to: "closed" } }, { kind: "stage.note", payload: { to: "escalated" } }],
      runs: 11,
    });
    expect(facts).toEqual({ predicted: { size: "small", risk: "low", estLoc: 120 }, actual: { added: 300, removed: 40, retries: { verify: 1, e2e: 0, ci: 2, total: 3 }, escalations: 1, format: "captures", durationMin: 95 }, runs: 11 });
  });
});
