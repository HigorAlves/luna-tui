import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { TaskRow } from "../../domain/task.ts";
import type { ExecResult } from "../../adapters/process/exec.ts";
import type { StageContext, StageResult } from "../ports.ts";
import { setupRunner } from "./setup.ts";

const proposal = {
  checks: [
    { name: "board tests", run: "cargo test", cwd: "board", paths: ["board/**"] },
    { name: "lint", run: "pnpm lint" },
  ],
  services: { postgres: { image: "postgres:16", exports: { DATABASE_URL: "postgres://app@postgres:5432/app" } } },
  toolchains: { node: "24", rust: "1.99" },
  policy: { qa: "none" },
};

function setup(opts: { pack?: StageResult; checks?: Record<string, ExecResult> } = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), "setup-"));
  const calls: Array<{ argv: string[]; options: { env?: NodeJS.ProcessEnv; cwd?: string; services?: unknown } }> = [];
  const exec = vi.fn(async (command: string, args: string[], options: { env?: NodeJS.ProcessEnv; cwd?: string; services?: unknown }) => {
    calls.push({ argv: [command, ...args], options });
    return opts.checks?.[[command, ...args].join(" ")] ?? { code: 0, stdout: "ok\n", stderr: "" };
  });
  const runPack = vi.fn(async () => opts.pack ?? ({ outcome: "pass", detail: { answer: { kind: "proposal", summary: "a Rust board and a Node machine", config: proposal, notes: ["no e2e surface"] } } } as StageResult));
  const run = setupRunner({ runPack, exec, stateDir, gitIdentity: async () => ({ name: "Ada L", email: "ada@x.dev" }) });
  const context: StageContext = {
    task: { id: "t1", repoPath: "/repo", worktreePath: null } as unknown as TaskRow,
    stage: "setup",
    attempt: 1,
    runId: "run-1",
    approvals: [],
    signal: new AbortController().signal,
  };
  return { run, context, exec, runPack, calls, stateDir };
}

describe("setup stage", () => {
  it("turns the pack's proposal into luna.yaml text, proves every check once with the services beside it, and hands both to the gate", async () => {
    const { run, context, calls } = setup({});
    const result = await run(context);
    expect(result.outcome).toBe("pass");
    expect(result.detail).toMatchObject({
      summary: "a Rust board and a Node machine",
      notes: ["no e2e surface"],
      proof: [
        { name: "board tests", cmd: "cargo test (in board)", ok: true },
        { name: "lint", cmd: "pnpm lint", ok: true },
      ],
    });
    const config = (result.detail as { config: string }).config;
    expect(config).toContain("checks:");
    expect(config).toContain("run: cargo test");
    expect(config).toContain("DATABASE_URL: postgres://app@postgres:5432/app");
    expect(config).toContain("qa: none");
    // Every check runs, scoping or not: the proof is of the file, not of a change.
    expect(calls.map((c) => c.argv)).toEqual([
      ["sh", "-c", "cd 'board' && cargo test"],
      ["sh", "-c", "pnpm lint"],
    ]);
    // In the repo checkout itself, as you, with the proposed services.
    expect(calls[0]!.options).toMatchObject({ cwd: "/repo", services: proposal.services, env: expect.objectContaining({ GIT_AUTHOR_NAME: "Ada L" }) });
  });

  it("still passes with a failing check, marked so you can decide, and keeps its tail", async () => {
    const { run, context } = setup({ checks: { "sh -c pnpm lint": { code: 1, stdout: "3 problems", stderr: "" } } });
    const result = await run(context);
    expect(result.outcome).toBe("pass");
    expect(result.detail).toMatchObject({ proof: [{ name: "board tests", ok: true }, { name: "lint", ok: false, tail: "3 problems" }] });
  });

  it("fails the stage when the proposal is not a luna.yaml the machine can read, naming the field", async () => {
    const bad = { outcome: "pass", detail: { answer: { kind: "proposal", summary: "s", config: { checks: [{ name: "t" }] } } } } as StageResult;
    const { run, context, exec } = setup({ pack: bad });
    const result = await run(context);
    expect(result.outcome).toBe("fail");
    expect(result.detail).toMatchObject({ error: expect.stringMatching(/checks\.0\.run/) });
    expect(exec).not.toHaveBeenCalled();
  });

  it("fails the stage when the proposal puts a pack on an engine the pack does not allow", async () => {
    const bad = { outcome: "pass", detail: { answer: { kind: "proposal", summary: "s", config: { engines: { triage: "jev" } } } } } as StageResult;
    const { run, context } = setup({ pack: bad });
    expect(await run(context)).toMatchObject({ outcome: "fail", detail: { error: expect.stringMatching(/engines\.triage: jev is not allowed for triage/) } });
  });

  it("passes an escalated or failed pack through unchanged", async () => {
    const escalated = { outcome: "escalated", detail: { reason: "no package manager I know", options: [] } } as StageResult;
    expect(await setup({ pack: escalated }).run(setup({}).context)).toEqual(escalated);
  });

  it("writes a checks.log for the proof like verifying does", async () => {
    const { run, context, stateDir } = setup({});
    const result = await run(context);
    expect(result.run?.transcriptPath).toBe(join(stateDir, "runs", "run-1", "checks.log"));
  });
});

describe("the base image a proposal names", () => {
  it("is shown on its own line for the gate, with the word that approving the setup does not approve it", async () => {
    const withBase = { outcome: "pass", detail: { answer: { kind: "proposal", summary: "s", config: { ...proposal, sandbox: { image: { base: "attacker/x:1\n<b>y" } } }, notes: [] } } } as StageResult;
    const { run, context } = setup({ pack: withBase });
    const result = await run(context);
    expect(result.detail?.sandboxBase).toMatch(/^sandbox\.image\.base: attacker\/x:1 &lt;b&gt;y/);
    expect(result.detail?.sandboxBase).toMatch(/does not approve the base/);
    expect(String(result.detail?.sandboxBase)).not.toMatch(/\n/);
    const plainSetup = setup();
    const plain = await plainSetup.run(plainSetup.context);
    expect(plain.detail).not.toHaveProperty("sandboxBase");
  });
});
