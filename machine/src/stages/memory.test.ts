import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { TaskRow } from "../db/entities.ts";
import { memoryReviewRunner, withMemoryReview } from "./memory.ts";
import type { StageContext, StageResult } from "./runner.ts";

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
