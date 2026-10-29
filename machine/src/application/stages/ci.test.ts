import { describe, expect, it, vi } from "vitest";

import type { TaskRow } from "../../domain/task.ts";
import type { Check } from "../github.ts";
import { fakeGitHub } from "../../test/github.ts";
import { ciWatchRunner } from "./ci.ts";
import type { StageContext, StageResult } from "../ports.ts";

const checks = (...states: Array<[string, string]>): Check[] =>
  states.map(([name, state]) => ({ name, state, link: `https://github.com/a/b/actions/runs/${name === "lint" ? 111 : 222}/job/1` }));
const finding = { path: "a.ts", line: 1, start_line: null, severity: "test", title: "red", body: "", suggestion_code: null, confidence: 1 };
const pack = (answer: Record<string, unknown>): StageResult => ({ outcome: "pass", detail: { answer } });

function setup(opts: { polls: Check[][]; pack?: StageResult; maxWaitMs?: number; parent?: { ref: string; checks: Check[] }; graceMs?: number; realSleepMs?: number }) {
  let poll = 0;
  const github = fakeGitHub({
    prChecks: async (_slug, ref) => (opts.parent && ref === opts.parent.ref ? opts.parent.checks : opts.polls[Math.min(poll++, opts.polls.length - 1)]!),
    findPr: async () => ({ url: "https://github.com/a/b/pull/7", number: 7, isDraft: true }),
    failedRunLog: async (_slug, runId) => `log of run ${runId}\nFAIL src/a.test.ts > boom\n`,
    rerunFailedJobs: async () => {},
  });
  const runPack = vi.fn(async (_context: StageContext, _ci?: unknown) => opts.pack ?? pack({ verdict: "green" }));
  const sleeps: number[] = [];
  const run = ciWatchRunner({
    github,
    runPack,
    slugOf: async () => "a/b",
    pollMs: 10,
    maxWaitMs: opts.maxWaitMs ?? 1_000,
    parentRef: async () => opts.parent?.ref ?? null,
    graceMs: opts.graceMs,
    sleep: async (ms) => {
      sleeps.push(ms);
      if (opts.realSleepMs) await new Promise((resolve) => setTimeout(resolve, opts.realSleepMs));
    },
  });
  const context = {
    task: { id: "t1", branch: "hardness/t1", worktreePath: "/wt", repoPath: "/repo" } as unknown as TaskRow,
    stage: "ci_watch",
    attempt: 1,
    runId: "r1",
    approvals: [],
    signal: new AbortController().signal,
  } as StageContext;
  return { run, context, github, runPack, sleeps };
}

describe("ci_watch after a push", () => {
  const before = checks(["guard", "SUCCESS"], ["lint", "FAILURE"]);

  it("does not pass on the fast checks while the workflow run the parent had has not started", async () => {
    const { run, context, github } = setup({
      parent: { ref: "parent-sha", checks: before },
      polls: [checks(["guard", "SUCCESS"]), checks(["guard", "SUCCESS"]), checks(["guard", "SUCCESS"], ["lint", "PENDING"]), checks(["guard", "SUCCESS"], ["lint", "SUCCESS"])],
    });
    const result = await run(context);
    expect(result).toMatchObject({ outcome: "pass", detail: { step: "checks" } });
    expect((result.detail?.checks as Check[]).map((c) => c.name).sort()).toEqual(["guard", "lint"]);
    expect(github.prChecks).toHaveBeenCalledWith("a/b", "hardness/t1");
  });

  it("stops waiting for a check that never comes once the grace is over", async () => {
    const { run, context } = setup({
      parent: { ref: "parent-sha", checks: before },
      polls: [checks(["guard", "SUCCESS"])],
      graceMs: 30,
      realSleepMs: 10,
    });
    const result = await run(context);
    expect(result.outcome).toBe("pass");
    expect((result.detail?.checks as Check[]).map((c) => c.name)).toEqual(["guard"]);
  });
});

describe("ci_watch", () => {
  it("passes when every check is green", async () => {
    const { run, context, runPack } = setup({ polls: [checks(["lint", "SUCCESS"], ["test", "SUCCESS"])] });
    const result = await run(context);
    expect(result).toMatchObject({ outcome: "pass", detail: { step: "checks" } });
    expect(runPack).not.toHaveBeenCalled();
  });

  it("passes with a note when no checks are configured", async () => {
    const { run, context } = setup({ polls: [[]] });
    const result = await run(context);
    expect(result.outcome).toBe("pass");
    expect(String(result.detail?.note)).toContain("no CI checks");
  });

  it("polls while checks are pending", async () => {
    const { run, context, github, sleeps } = setup({
      polls: [checks(["lint", "PENDING"]), checks(["lint", "IN_PROGRESS"]), checks(["lint", "SUCCESS"])],
    });
    expect((await run(context)).outcome).toBe("pass");
    expect(github.prChecks).toHaveBeenCalledTimes(3);
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
    const { run, context, github } = setup({
      polls: [checks(["lint", "FAILURE"]), checks(["lint", "SUCCESS"])],
      pack: pack({ verdict: "flake", summary: "network" }),
    });
    const result = await run(context);
    expect(github.rerunFailedJobs).toHaveBeenCalledWith("a/b", "111");
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

  it("hands the pack the PR, the checks and the failed run's log, fetched on the host", async () => {
    const { run, context, runPack, github } = setup({
      polls: [checks(["lint", "FAILURE"], ["unit", "SUCCESS"])],
      pack: pack({ verdict: "fixable", summary: "lint broke", findings: [finding] }),
    });
    await run(context);
    expect(github.failedRunLog).toHaveBeenCalledWith("a/b", "111");
    expect(runPack).toHaveBeenCalledWith(context, {
      pr: { number: 7, url: "https://github.com/a/b/pull/7" },
      checks: [
        { name: "lint", state: "FAILURE", url: "https://github.com/a/b/actions/runs/111/job/1" },
        { name: "unit", state: "SUCCESS", url: "https://github.com/a/b/actions/runs/222/job/1" },
      ],
      logs: "log of run 111\nFAIL src/a.test.ts > boom\n",
    });
  });

  it("escalates infra and needs_debug with the pack's reason and options", async () => {
    for (const verdict of ["infra", "needs_debug"]) {
      const { run, context } = setup({
        polls: [checks(["lint", "FAILURE"])],
        pack: pack({ kind: "escalated", verdict, summary: "runner down", reason: "runner out of disk", options: ["clean the runner"] }),
      });
      const result = await run(context);
      expect(result).toMatchObject({ outcome: "escalated", detail: { verdict, reason: "runner out of disk", options: ["clean the runner"] } });
    }
  });

  it("passes an escalated pack result straight through", async () => {
    const { run, context } = setup({
      polls: [checks(["lint", "FAILURE"])],
      pack: { outcome: "escalated", detail: { reason: "gh has no credential here", options: ["add a token"] } },
    });
    const result = await run(context);
    expect(result).toMatchObject({ outcome: "escalated", detail: { reason: "gh has no credential here", step: "triage" } });
  });

  it("fails when CI does not settle in time", async () => {
    const { run, context } = setup({ polls: [checks(["lint", "PENDING"])], maxWaitMs: 0 });
    const result = await run(context);
    expect(result.outcome).toBe("fail");
    expect(String(result.detail?.error)).toBe("CI did not settle in 45m");
  });
});
