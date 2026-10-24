import { describe, expect, it, vi } from "vitest";

import type { TaskRow } from "../domain/task.ts";
import type { ExecResult } from "../sandbox/exec.ts";
import { ciWatchRunner } from "./ci.ts";
import type { StageContext, StageResult } from "./runner.ts";

const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
const checks = (...states: Array<[string, string]>) =>
  ok(JSON.stringify(states.map(([name, state]) => ({ name, state, link: `https://github.com/a/b/actions/runs/${name === "lint" ? 111 : 222}/job/1` }))));
const finding = { path: "a.ts", line: 1, start_line: null, severity: "test", title: "red", body: "", suggestion_code: null, confidence: 1 };
const pack = (answer: Record<string, unknown>): StageResult => ({ outcome: "pass", detail: { answer } });

function setup(opts: { polls: ExecResult[]; pack?: StageResult; maxWaitMs?: number }) {
  const calls: string[][] = [];
  let poll = 0;
  const exec = vi.fn(async (command: string, args: string[]) => {
    calls.push([command, ...args]);
    if (args[1] === "checks") return opts.polls[Math.min(poll++, opts.polls.length - 1)]!;
    return ok();
  });
  const runPack = vi.fn(async () => opts.pack ?? pack({ verdict: "green" }));
  const sleeps: number[] = [];
  const run = ciWatchRunner({
    exec,
    runPack,
    pollMs: 10,
    maxWaitMs: opts.maxWaitMs ?? 1_000,
    sleep: async (ms) => void sleeps.push(ms),
  });
  const context = {
    task: { id: "t1", branch: "hardness/t1", worktreePath: "/wt", repoPath: "/repo" } as unknown as TaskRow,
    stage: "ci_watch",
    attempt: 1,
    runId: "r1",
    approvals: [],
    signal: new AbortController().signal,
  } as StageContext;
  return { run, context, calls, runPack, sleeps };
}

describe("ci_watch", () => {
  it("passes when every check is green", async () => {
    const { run, context, runPack } = setup({ polls: [checks(["lint", "SUCCESS"], ["test", "SUCCESS"])] });
    const result = await run(context);
    expect(result).toMatchObject({ outcome: "pass", detail: { step: "checks" } });
    expect(runPack).not.toHaveBeenCalled();
  });

  it("passes with a note when no checks are configured", async () => {
    const { run, context } = setup({ polls: [ok("[]")] });
    const result = await run(context);
    expect(result.outcome).toBe("pass");
    expect(String(result.detail?.note)).toContain("no CI checks");
  });

  it("polls while checks are pending", async () => {
    const { run, context, calls, sleeps } = setup({
      polls: [checks(["lint", "PENDING"]), checks(["lint", "IN_PROGRESS"]), checks(["lint", "SUCCESS"])],
    });
    expect((await run(context)).outcome).toBe("pass");
    expect(calls.filter((c) => c[2] === "checks")).toHaveLength(3);
    expect(sleeps).toEqual([10, 10]);
  });

  it("fails fixable with the pack's findings", async () => {
    const { run, context, runPack } = setup({
      polls: [checks(["lint", "FAILURE"])],
      pack: pack({ verdict: "fixable", summary: "lint broke", findings: [finding] }),
    });
    const result = await run(context);
    expect(runPack).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ outcome: "fail", detail: { verdict: "fixable", findings: [finding] }, findings: [finding] });
  });

  it("re-runs a flake once and passes when it goes green", async () => {
    const { run, context, calls } = setup({
      polls: [checks(["lint", "FAILURE"]), checks(["lint", "SUCCESS"])],
      pack: pack({ verdict: "flake", summary: "network" }),
    });
    const result = await run(context);
    expect(calls).toContainEqual(["gh", "run", "rerun", "--failed", "111"]);
    expect(result.outcome).toBe("pass");
    expect(String(result.detail?.note)).toContain("flake, re-run passed");
  });

  it("treats a flake that stays red as fixable", async () => {
    const { run, context } = setup({
      polls: [checks(["lint", "FAILURE"]), checks(["lint", "FAILURE"])],
      pack: pack({ verdict: "flake", summary: "network", findings: [finding] }),
    });
    const result = await run(context);
    expect(result).toMatchObject({ outcome: "fail", detail: { verdict: "fixable" } });
  });

  it("fails infra with the requested actions passed through", async () => {
    const requested = [{ kind: "tracker_write", target: "ops", payload: { text: "runner down" } }];
    const { run, context } = setup({
      polls: [checks(["lint", "FAILURE"])],
      pack: pack({ verdict: "infra", summary: "runner down", requested }),
    });
    const result = await run(context);
    expect(result).toMatchObject({ outcome: "fail", detail: { verdict: "infra", requested }, requested });
  });

  it("fails when CI does not settle in time", async () => {
    const { run, context } = setup({ polls: [checks(["lint", "PENDING"])], maxWaitMs: 0 });
    const result = await run(context);
    expect(result.outcome).toBe("fail");
    expect(String(result.detail?.error)).toBe("CI did not settle in 45m");
  });
});
