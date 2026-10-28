import { describe, expect, it, vi } from "vitest";

import type { TaskRow } from "../../domain/task.ts";
import type { ExecResult } from "../../adapters/process/exec.ts";
import { fakeGitHub } from "../../test/github.ts";
import type { StageContext } from "../ports.ts";
import { shipRunnerWith } from "./ship.ts";

const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });

function setup(github: ReturnType<typeof fakeGitHub>) {
  const exec = vi.fn(async () => ok());
  const context = {
    task: { id: "t1", title: "feat: thing", description: "d", criteria: [], branch: "hardness/t1", worktreePath: "/wt", repoPath: "/repo", source: null } as unknown as TaskRow,
    stage: "shipping",
    attempt: 1,
    runId: "r1",
    approvals: [],
    signal: new AbortController().signal,
  } as StageContext;
  return { run: shipRunnerWith({ exec, github, slugOf: async () => "a/b" }), context, exec };
}
const pr = (isDraft: boolean) => ({ url: "https://x/pull/3", number: 3, isDraft });

describe("shipping", () => {
  it("pushes, then marks a draft PR ready", async () => {
    const github = fakeGitHub({ findPr: async () => pr(true), markPrReady: async () => {} });
    const { run, context, exec } = setup(github);
    const result = await run(context);
    expect(result).toMatchObject({ outcome: "pass", detail: { prUrl: "https://x/pull/3", readied: true } });
    expect(exec).toHaveBeenCalledTimes(1);
    expect(github.markPrReady).toHaveBeenCalledWith("a/b", 3);
  });

  it("does nothing to a PR that is already ready", async () => {
    const github = fakeGitHub({ findPr: async () => pr(false) });
    const { run, context } = setup(github);
    expect(await run(context)).toMatchObject({ outcome: "pass", detail: { readied: false } });
    expect(github.markPrReady).not.toHaveBeenCalled();
  });

  it("creates a non-draft PR when delivering never opened one", async () => {
    const github = fakeGitHub({ findPr: async () => null, openPr: async () => ({ url: "https://x/pull/9", number: 9, isDraft: false }) });
    const { run, context } = setup(github);
    expect(await run(context)).toMatchObject({ outcome: "pass", detail: { prUrl: "https://x/pull/9", readied: false } });
    expect(github.openPr).toHaveBeenCalledWith("a/b", expect.objectContaining({ draft: false }));
  });

  it("fails with GitHub's words when marking ready fails", async () => {
    const github = fakeGitHub({ findPr: async () => pr(true), markPrReady: async () => { throw new Error("boom"); } });
    const { run, context } = setup(github);
    const result = await run(context);
    expect(result.outcome).toBe("fail");
    expect(String(result.detail?.error)).toContain("boom");
  });
});
