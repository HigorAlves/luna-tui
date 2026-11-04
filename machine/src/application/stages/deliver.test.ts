import { describe, expect, it, vi } from "vitest";

import type { TaskRow } from "../../domain/task.ts";
import type { ExecResult } from "../../adapters/process/exec.ts";
import { fakeGitHub } from "../../test/github.ts";
import type { StageContext } from "../ports.ts";
import { deliverRunner } from "./deliver.ts";

const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
const bad = (stderr = "nope"): ExecResult => ({ code: 1, stdout: "", stderr });

function setup(github: ReturnType<typeof fakeGitHub>, opts: { push?: ExecResult; task?: Record<string, unknown>; respond?: (args: string[]) => ExecResult | undefined; defaultBranch?: string | null } = {}) {
  const calls: string[][] = [];
  const exec = vi.fn(async (command: string, args: string[]) => {
    calls.push([command, ...args]);
    return opts.respond?.(args) ?? opts.push ?? ok();
  });
  const context = {
    task: { id: "t1", title: "feat: thing", description: "d", criteria: ["c"], branch: "hardness/t1", worktreePath: "/wt", repoPath: "/repo", source: null, ...opts.task } as unknown as TaskRow,
    stage: "delivering",
    attempt: 1,
    runId: "r1",
    approvals: [],
    signal: new AbortController().signal,
  } as StageContext;
  return { run: deliverRunner({ exec, github, slugOf: async () => "acme/widgets", defaultBranch: async () => (opts.defaultBranch === undefined ? "main" : opts.defaultBranch) }), context, calls };
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

describe("delivering a branch that conflicts with the default branch", () => {
  const G = ["git", "-c", "core.hooksPath=/dev/null", "-C", "/wt"];
  const pr = { url: "https://x/pull/3", number: 3, isDraft: true };
  const facts = (mergeable: string) => async () => ({ mergeable }) as never;

  it("rebases once onto origin/main and pushes with a lease, then passes", async () => {
    const github = fakeGitHub({ findPr: async () => pr, prFacts: facts("CONFLICTING") });
    const { run, context, calls } = setup(github);
    const result = await run(context);
    expect(result.outcome).toBe("pass");
    expect(result.detail).toMatchObject({ rebased: true, onto: "origin/main" });
    expect(calls).toEqual([
      [...G, "push", "-u", "origin", "hardness/t1"],
      [...G, "fetch", "--quiet", "--end-of-options", "origin", "main"],
      [...G, "rebase", "origin/main"],
      [...G, "push", "--force-with-lease", "-u", "origin", "hardness/t1"],
    ]);
  });

  it("fails naming the files when the rebase stops, after aborting it", async () => {
    const github = fakeGitHub({ findPr: async () => pr, prFacts: facts("CONFLICTING") });
    const { run, context, calls } = setup(github, {
      respond: (args) => (args.includes("rebase") && !args.includes("--abort") ? bad("CONFLICT") : args.includes("diff") ? ok("a.ts\nb.ts\n") : undefined),
    });
    const result = await run(context);
    expect(result.outcome).toBe("fail");
    expect(result.detail).toMatchObject({ error: "the branch conflicts with main and the rebase stopped on: a.ts, b.ts", conflicts: ["a.ts", "b.ts"], escalation: "other" });
    expect(calls).toContainEqual([...G, "diff", "--name-only", "--diff-filter=U"]);
    expect(calls).toContainEqual([...G, "rebase", "--abort"]);
    expect(calls.some((c) => c.includes("--force-with-lease"))).toBe(false);
  });

  it("refuses a default branch that reads as an option or is not a ref name, before any git call: the ref lives in the container-writable git dir", async () => {
    for (const base of ["--upload-pack=/g/.git/evil.sh", "-v", "a b", "", null]) {
      const github = fakeGitHub({ findPr: async () => pr, prFacts: facts("CONFLICTING") });
      const { run, context, calls } = setup(github, { defaultBranch: base });
      const result = await run(context);
      expect(result.outcome).toBe("fail");
      expect(String(result.detail?.error)).toMatch(/no usable default branch/);
      expect(calls.filter((c) => c.includes("fetch") || c.includes("rebase"))).toEqual([]);
    }
  });

  it("fails with the push error when the push after the rebase is refused", async () => {
    const github = fakeGitHub({ findPr: async () => pr, prFacts: facts("CONFLICTING") });
    const { run, context } = setup(github, { respond: (args) => (args.includes("--force-with-lease") ? bad("stale info") : undefined) });
    const result = await run(context);
    expect(result.outcome).toBe("fail");
    expect(String(result.detail?.error)).toContain("stale info");
  });

  it("does nothing more on a mergeable PR, notes an UNKNOWN one, and ignores a prFacts that throws", async () => {
    for (const [mergeable, note] of [["MERGEABLE", false], ["UNKNOWN", true]] as const) {
      const { run, context, calls } = setup(fakeGitHub({ findPr: async () => pr, prFacts: facts(mergeable) }));
      const result = await run(context);
      expect(result.outcome).toBe("pass");
      expect(calls).toHaveLength(1);
      expect(result.detail?.mergeable === "UNKNOWN").toBe(note);
    }
    const throwing = setup(fakeGitHub({ findPr: async () => pr, prFacts: async () => { throw new Error("rate limited"); } }));
    expect((await throwing.run(throwing.context)).outcome).toBe("pass");
    expect(throwing.calls).toHaveLength(1);
  });
});
