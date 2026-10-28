import { describe, expect, it, vi } from "vitest";

import type { TaskRow } from "../../domain/task.ts";
import type { ExecResult } from "../../adapters/process/exec.ts";
import { fakeGitHub } from "../../test/github.ts";
import type { StageContext } from "../ports.ts";
import { deliverRunner } from "./deliver.ts";

const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
const bad = (stderr = "nope"): ExecResult => ({ code: 1, stdout: "", stderr });

function setup(github: ReturnType<typeof fakeGitHub>, opts: { push?: ExecResult; task?: Record<string, unknown> } = {}) {
  const calls: string[][] = [];
  const exec = vi.fn(async (command: string, args: string[]) => {
    calls.push([command, ...args]);
    return opts.push ?? ok();
  });
  const context = {
    task: { id: "t1", title: "feat: thing", description: "d", criteria: ["c"], branch: "hardness/t1", worktreePath: "/wt", repoPath: "/repo", source: null, ...opts.task } as unknown as TaskRow,
    stage: "delivering",
    attempt: 1,
    runId: "r1",
    approvals: [],
    signal: new AbortController().signal,
  } as StageContext;
  return { run: deliverRunner({ exec, github, slugOf: async () => "acme/widgets" }), context, calls };
}

describe("delivering", () => {
  it("pushes with git, then opens a draft PR through GitHub, logging pr.opened", async () => {
    const github = fakeGitHub({
      findPr: async () => null,
      openPr: async () => ({ url: "https://github.com/acme/widgets/pull/7", number: 7, isDraft: true }),
    });
    const { run, context, calls } = setup(github);
    const result = await run(context);
    expect(result.outcome).toBe("pass");
    expect(result.detail).toMatchObject({ prUrl: "https://github.com/acme/widgets/pull/7", prNumber: 7, draft: true, reused: false });
    expect(result.events).toMatchObject([{ kind: "pr.opened", payload: { url: "https://github.com/acme/widgets/pull/7", number: 7 } }]);
    expect(calls).toEqual([["git", "-c", "core.hooksPath=/dev/null", "-C", "/wt", "push", "-u", "origin", "hardness/t1"]]);
    expect(github.openPr).toHaveBeenCalledWith("acme/widgets", expect.objectContaining({ head: "hardness/t1", draft: true, title: "feat: thing" }));
  });

  it("reuses an existing PR", async () => {
    const github = fakeGitHub({ findPr: async () => ({ url: "https://x/pull/3", number: 3, isDraft: true }) });
    const { run, context } = setup(github);
    const result = await run(context);
    expect(result.detail).toMatchObject({ prUrl: "https://x/pull/3", prNumber: 3, reused: true });
    expect(github.openPr).not.toHaveBeenCalled();
  });

  it("fails with the push error and never asks GitHub", async () => {
    const github = fakeGitHub();
    const { run, context } = setup(github, { push: bad("rejected: non-fast-forward") });
    const result = await run(context);
    expect(result.outcome).toBe("fail");
    expect(String(result.detail?.error)).toContain("rejected: non-fast-forward");
    expect(github.calls).toEqual([]);
  });

  it("fails with GitHub's words when opening the PR fails, and when the task has no branch", async () => {
    const github = fakeGitHub({ findPr: async () => null });
    const { run, context } = setup(github);
    const result = await run(context);
    expect(result.outcome).toBe("fail");
    expect(String(result.detail?.error)).toMatch(/unexpected github.openPr/);
    const noBranch = setup(fakeGitHub(), { task: { branch: null } });
    expect((await noBranch.run(noBranch.context)).outcome).toBe("fail");
  });
});
