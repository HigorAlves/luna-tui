import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { TaskRow } from "../db/entities.ts";
import type { ExecResult } from "../sandbox/exec.ts";
import type { StageContext, StageResult } from "./runner.ts";
import { verifyRunner } from "./verify.ts";

const finding = (over: Record<string, unknown> = {}) => ({
  path: "a.ts",
  line: 3,
  start_line: null,
  severity: "bug",
  title: "off by one",
  body: "b",
  suggestion_code: null,
  confidence: 0.9,
  ...over,
});

function setup(opts: {
  checks?: Record<string, ExecResult>;
  detected?: Record<string, unknown>;
  pack?: StageResult;
  controller?: AbortController;
  noPack?: boolean;
}) {
  const stateDir = mkdtempSync(join(tmpdir(), "verify-"));
  const calls: string[][] = [];
  const exec = vi.fn(async (command: string, args: string[]) => {
    calls.push([command, ...args]);
    return opts.checks?.[[command, ...args].join(" ")] ?? { code: 0, stdout: "ok\n", stderr: "" };
  });
  const runPack = vi.fn(async () => opts.pack ?? { outcome: "pass" as const, detail: { answer: { verdict: "pass", summary: "fine", findings: [] } } });
  const run = verifyRunner({
    exec,
    runPack: opts.noPack ? null : runPack,
    stateDir,
    detect: async () => (opts.detected ?? { manager: "pnpm", test: ["pnpm", "run", "test"], lint: ["pnpm", "run", "lint"] }) as never,
  });
  const controller = opts.controller ?? new AbortController();
  const context: StageContext = {
    task: { id: "t1", worktreePath: "/wt", repoPath: "/repo" } as unknown as TaskRow,
    stage: "verifying",
    attempt: 1,
    runId: "run-1",
    approvals: [],
    signal: controller.signal,
  };
  return { run, context, exec, runPack, calls, stateDir };
}

describe("verifying stage", () => {
  it("fails on a red check with its tail as a test finding, and never calls the pack", async () => {
    const tail = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
    const { run, context, runPack, stateDir } = setup({
      checks: { "pnpm run test": { code: 1, stdout: tail, stderr: "" } },
    });
    const result = await run(context);
    expect(result.outcome).toBe("fail");
    expect(runPack).not.toHaveBeenCalled();
    const detail = result.detail as { step: string; failed: Array<{ name: string; tail: string; cmd: string }> };
    expect(detail.step).toBe("checks");
    expect(detail.failed).toHaveLength(1);
    expect(detail.failed[0]).toMatchObject({ name: "test", cmd: "pnpm run test" });
    expect(detail.failed[0]!.tail.split("\n")).toHaveLength(60);
    expect(detail.failed[0]!.tail).toContain("line 99");
    expect(result.findings).toEqual([
      expect.objectContaining({ path: "", line: 0, severity: "test", title: "test failed", confidence: 1, body: detail.failed[0]!.tail }),
    ]);
    expect((result.detail as { findings: unknown[] }).findings).toEqual(result.findings);
    expect(readFileSync(join(stateDir, "runs", "run-1", "checks.log"), "utf8")).toContain("line 99");
  });

  it("runs the review pack when checks pass and fails on its fail verdict", async () => {
    const f = finding();
    const { run, context, runPack } = setup({
      pack: { outcome: "pass", detail: { answer: { verdict: "fail", summary: "bug", findings: [f] } }, findings: [] },
    });
    const result = await run(context);
    expect(runPack).toHaveBeenCalledOnce();
    expect(result.outcome).toBe("fail");
    expect(result.findings).toEqual([f]);
    expect(result.detail).toMatchObject({ step: "review", verdict: "fail", summary: "bug", findings: [f] });
    expect((result.detail as { checks: Array<{ name: string }> }).checks.map((c) => c.name)).toEqual(["test", "lint"]);
  });

  it("passes when checks and the review pass", async () => {
    const { run, context } = setup({});
    const result = await run(context);
    expect(result.outcome).toBe("pass");
    expect(result.detail).toMatchObject({ step: "review", verdict: "pass", summary: "fine" });
  });

  it("computes the verdict mechanically when the answer has none", async () => {
    const low = finding({ confidence: 0.5 });
    const nit = finding({ severity: "nit" });
    const mk = (findings: unknown[]) => ({ outcome: "pass" as const, detail: { answer: { findings } }, findings: [] });
    expect((await setup({ pack: mk([low, nit]) }).run(setup({}).context)).outcome).toBe("pass");
    const s = setup({ pack: mk([finding({ severity: "security" })]) });
    expect((await s.run(s.context)).outcome).toBe("fail");
  });

  it("falls back to the result findings when the answer has none", async () => {
    const f = finding();
    const s = setup({ pack: { outcome: "pass", detail: {}, findings: [f] } });
    const result = await s.run(s.context);
    expect(result.outcome).toBe("fail");
    expect(result.findings).toEqual([f]);
  });

  it("fails when no test command is detected, never reaching the pack", async () => {
    const { run, context, runPack, exec } = setup({ detected: { manager: null } });
    const result = await run(context);
    expect(exec).not.toHaveBeenCalled();
    expect(runPack).not.toHaveBeenCalled();
    expect(result.outcome).toBe("fail");
    expect((result.detail as { error: string }).error).toContain("don't know how to test this repo");
  });

  it("fails when only lint is detected (no test command)", async () => {
    const { run, context } = setup({ detected: { manager: "pnpm", lint: ["pnpm", "run", "lint"] } });
    expect((await run(context)).outcome).toBe("fail");
  });

  it("passes without running anything when the task has no worktree", async () => {
    const { run, context, exec, runPack } = setup({});
    context.task = { id: "t1", worktreePath: null, repoPath: "/repo" } as unknown as TaskRow;
    const result = await run(context);
    expect(result.outcome).toBe("pass");
    expect(result.detail).toMatchObject({ note: "no worktree; implementer was stubbed" });
    expect(exec).not.toHaveBeenCalled();
    expect(runPack).not.toHaveBeenCalled();
  });

  it("sets HARDNESS_STAGE=verifying and a 30 minute budget on every check", async () => {
    const { run, context, exec } = setup({});
    await run(context);
    expect(exec).toHaveBeenCalledTimes(2);
    for (const call of exec.mock.calls) {
      const options = (call as unknown as [string, string[], { env?: NodeJS.ProcessEnv; timeoutMs?: number; signal?: AbortSignal }])[2];
      expect(options.env?.HARDNESS_STAGE).toBe("verifying");
      expect(options.signal).toBeDefined();
      expect(options.timeoutMs).toBeGreaterThan(29 * 60_000);
      expect(options.timeoutMs).toBeLessThanOrEqual(30 * 60_000);
    }
  });

  it("skips the review with a note when agents are off (runPack null)", async () => {
    const s = setup({ noPack: true });
    const result = await s.run(s.context);
    expect(s.exec).toHaveBeenCalledTimes(2);
    expect(result.outcome).toBe("pass");
    expect(result.detail).toMatchObject({ step: "checks", note: "review: skipped (agents off)" });
  });

  it("adds an error line with the failing command and its output to a red check", async () => {
    const { run, context } = setup({ checks: { "pnpm run test": { code: 1, stdout: "boom", stderr: "" } } });
    const result = await run(context);
    expect((result.detail as { error: string }).error).toBe("`pnpm run test` failed:\nboom");
  });

  it("treats a pack that asks questions as a pass with a note", async () => {
    const s = setup({ pack: { outcome: "needs_input", detail: { questions: [{ q: "?" }] } } });
    const result = await s.run(s.context);
    expect(result.outcome).toBe("pass");
    expect(result.detail).toMatchObject({ verdict: "pass", note: expect.stringContaining("question") });
  });

  it("returns the pack's own failure with the checks attached", async () => {
    const s = setup({ pack: { outcome: "fail", detail: { error: "timed out" } } });
    const result = await s.run(s.context);
    expect(result.outcome).toBe("fail");
    expect(result.detail).toMatchObject({ error: "timed out", step: "review" });
  });

  it("fails as aborted when the signal fires", async () => {
    const controller = new AbortController();
    const s = setup({ controller });
    s.exec.mockImplementationOnce(async () => {
      controller.abort();
      return { code: 1, stdout: "", stderr: "" };
    });
    const result = await s.run(s.context);
    expect(result.outcome).toBe("fail");
    expect(result.detail).toMatchObject({ error: "aborted" });
    expect(s.runPack).not.toHaveBeenCalled();
  });
});
