import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { TaskRow } from "../../domain/task.ts";
import type { ExecResult } from "../../adapters/process/exec.ts";
import type { StageContext, StageResult } from "../ports.ts";
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
  identity?: { name: string; email: string } | null;
  /** The repo's own checks from luna.yaml; undefined means none declared. */
  lunaChecks?: Array<{ name: string; run: string; cwd?: string; paths?: string[] }>;
  changed?: string[] | null;
  services?: Record<string, { image: string; exports?: Record<string, string> }>;
}) {
  const stateDir = mkdtempSync(join(tmpdir(), "verify-"));
  const calls: string[][] = [];
  const exec = vi.fn(async (command: string, args: string[], _options?: { env?: NodeJS.ProcessEnv; services?: unknown }) => {
    calls.push([command, ...args]);
    return opts.checks?.[[command, ...args].join(" ")] ?? { code: 0, stdout: "ok\n", stderr: "" };
  });
  const runPack = vi.fn(async () => opts.pack ?? { outcome: "pass" as const, detail: { answer: { verdict: "pass", summary: "fine", findings: [] } } });
  const run = verifyRunner({
    exec,
    runPack: opts.noPack ? null : runPack,
    stateDir,
    detect: async () => (opts.detected ?? { manager: "pnpm", test: ["pnpm", "run", "test"], lint: ["pnpm", "run", "lint"] }) as never,
    gitIdentity: async () => ("identity" in opts ? opts.identity! : { name: "Ada L", email: "ada@x.dev" }),
    policy: async () => ({ checks: opts.lunaChecks ?? null, services: opts.services ?? {} }),
    changedPaths: async () => ("changed" in opts ? opts.changed! : null),
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

  it("escalates, never retrying, when the test command itself is missing from the runner image", async () => {
    // Exit 127 is the shell's "command not found": no implementing attempt can fix the image.
    const { run, context, runPack } = setup({
      checks: { "pnpm run test": { code: 127, stdout: "", stderr: "sh: pnpm: not found\n" } },
    });
    const result = await run(context);
    expect(result.outcome).toBe("escalated");
    expect(result.detail).toMatchObject({ reason: expect.stringMatching(/pnpm run test.*runner image/) });
    expect(runPack).not.toHaveBeenCalled();
  });

  it("runs every check as you: the identity git resolves for the repo rides into the check container", async () => {
    const { run, context, exec } = setup({});
    await run(context);
    const env = exec.mock.calls[0]![2]!.env!;
    expect(env).toMatchObject({ GIT_AUTHOR_NAME: "Ada L", GIT_AUTHOR_EMAIL: "ada@x.dev", GIT_COMMITTER_NAME: "Ada L", GIT_COMMITTER_EMAIL: "ada@x.dev" });
  });

  it("escalates before running anything when the repo has no git identity: a suite that commits would fail as nobody", async () => {
    const { run, context, exec, runPack } = setup({ identity: null });
    const result = await run(context);
    expect(result.outcome).toBe("escalated");
    expect(result.detail).toMatchObject({ step: "checks", reason: expect.stringMatching(/user\.name.*user\.email/) });
    expect(exec).not.toHaveBeenCalled();
    expect(runPack).not.toHaveBeenCalled();
  });

  it("runs the repo's own checks from luna.yaml, each through sh in its cwd, instead of detecting them", async () => {
    const { run, context, calls, runPack } = setup({
      lunaChecks: [
        { name: "board tests", run: "cargo test", cwd: "board" },
        { name: "lint", run: "pnpm lint" },
      ],
    });
    const result = await run(context);
    expect(calls).toEqual([
      ["sh", "-c", "cd 'board' && cargo test"],
      ["sh", "-c", "pnpm lint"],
    ]);
    expect(result.outcome).toBe("pass");
    expect(result.detail).toMatchObject({ checks: [{ name: "board tests", cmd: "cargo test (in board)", ok: true }, { name: "lint", ok: true }] });
    expect(runPack).toHaveBeenCalledOnce();
  });

  it("runs only the checks whose paths the branch touches, and says which were skipped", async () => {
    const { run, context, calls } = setup({
      lunaChecks: [
        { name: "board tests", run: "cargo test", cwd: "board", paths: ["board/**"] },
        { name: "machine tests", run: "pnpm test", cwd: "machine", paths: ["machine/**"] },
      ],
      changed: ["board/src/ui.rs"],
    });
    const result = await run(context);
    expect(calls).toEqual([["sh", "-c", "cd 'board' && cargo test"]]);
    expect(result.detail).toMatchObject({ checks: [{ name: "board tests", ok: true }, { name: "machine tests", skipped: "no change under machine/**" }] });
  });

  it("names a failed luna.yaml check by its own name, with its tail, so the finding reads like the file", async () => {
    const { run, context, runPack } = setup({
      lunaChecks: [{ name: "board tests", run: "cargo test", cwd: "board" }],
      checks: { "sh -c cd 'board' && cargo test": { code: 101, stdout: "test x ... FAILED", stderr: "" } },
    });
    const result = await run(context);
    expect(result.outcome).toBe("fail");
    expect(result.detail).toMatchObject({ summary: "board tests failed", error: expect.stringContaining("cargo test (in board)") });
    expect(result.findings).toEqual([expect.objectContaining({ severity: "test", title: "board tests failed", body: "test x ... FAILED" })]);
    expect(runPack).not.toHaveBeenCalled();
  });

  it("asks for the repo's services beside every check, so a suite that needs a database gets one", async () => {
    const services = { postgres: { image: "postgres:16", exports: { DATABASE_URL: "postgres://app@postgres:5432/app" } } };
    const { run, context, exec } = setup({ services });
    await run(context);
    expect(exec.mock.calls[0]![2]).toMatchObject({ services });
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

  it("skips the checks with a note when no test command is detected, and still runs the pack", async () => {
    const { run, context, runPack, exec } = setup({ detected: { manager: null } });
    const result = await run(context);
    expect(exec).not.toHaveBeenCalled();
    expect(runPack).toHaveBeenCalledTimes(1);
    expect(result.outcome).toBe("pass");
    expect(String(result.detail?.note)).toContain("no test command");
  });

  it("runs lint when only lint is detected, skips the test check, and runs the pack", async () => {
    const { run, context, runPack, calls } = setup({ detected: { manager: "pnpm", lint: ["pnpm", "run", "lint"] } });
    const result = await run(context);
    expect(calls).toEqual([["pnpm", "run", "lint"]]);
    expect(runPack).toHaveBeenCalledTimes(1);
    expect(result.outcome).toBe("pass");
  });

  it("still fails on a red lint even when there is no test command", async () => {
    const { run, context, runPack } = setup({
      detected: { manager: "pnpm", lint: ["pnpm", "run", "lint"] },
      checks: { "pnpm run lint": { code: 1, stdout: "", stderr: "eslint: 3 errors" } },
    });
    const result = await run(context);
    expect(runPack).not.toHaveBeenCalled();
    expect(result.outcome).toBe("fail");
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

  it("fails on a failing result even with zero findings", async () => {
    const results = [{ title: "t", criterion: "c", approach: "a", outcome: "fail" }];
    const { run, context } = setup({
      pack: { outcome: "pass", detail: { answer: { verdict: "pass", summary: "fine", findings: [], results } } },
    });
    const { outcome, detail } = await run(context);
    expect(outcome).toBe("fail");
    expect(detail?.results).toEqual(results);
  });

  it("passes with passing results and no findings", async () => {
    const results = [{ title: "t", criterion: "c", approach: "a", outcome: "pass" }];
    const { run, context } = setup({
      pack: { outcome: "pass", detail: { answer: { verdict: "pass", summary: "fine", findings: [], results } } },
    });
    const { outcome, detail } = await run(context);
    expect(outcome).toBe("pass");
    expect(detail?.results).toEqual(results);
  });

  it("passes through an escalated pack unchanged, never computing a verdict over it", async () => {
    const escalated: StageResult = { outcome: "escalated", detail: { reason: "a pre-existing failure", options: [] } };
    const { run, context } = setup({ pack: escalated });
    const { outcome, detail } = await run(context);
    expect(outcome).toBe("escalated");
    expect(detail).toMatchObject({ reason: "a pre-existing failure", step: "review" });
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
