import { at } from "../../adapters/git/machine-repo.ts";
import { HOST_GIT } from "../../adapters/git/worktree.ts";
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
    // Recording what was pushed is the machine's own bookkeeping, asserted once below.
    if (args.includes("update-ref")) return ok();
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

describe("what the machine pushed", () => {
  it("is recorded in the card's own repository, so an unpushed commit is told from a pushed one by what the machine did", async () => {
    const { pushBranch, pushCheckpoint } = await import("./deliver.ts");
    const calls: string[][] = [];
    const exec = async (_c: string, args: string[]) => (calls.push(args), ok());
    expect(await pushBranch(exec, "hardness/t1", "/wt")).toBeNull();
    expect(await pushCheckpoint(exec, "hardness/t1", "/wt")).toBeNull();
    const refs = calls.filter((c) => c.includes("update-ref")).map((c) => c.slice(c.indexOf("update-ref") + 1));
    expect(refs).toEqual([["refs/luna/pushed/hardness/t1", "refs/heads/hardness/t1"], ["refs/luna/pushed/wip/hardness/t1", "HEAD"]]);
    const failed = async () => bad();
    const before = refs.length;
    expect(await pushBranch(failed, "hardness/t1", "/wt")).toMatch(/push failed/);
    expect(refs.length).toBe(before);
  });
});

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
    expect(calls).toEqual([["git", ...HOST_GIT, ...at("/wt"), "push", "-u", "origin", "hardness/t1"]]);
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

describe("the draft PR's body", () => {
  const withBody = (github: ReturnType<typeof fakeGitHub>) => {
    const { context } = setup(github, { task: { record: { goal: "Readers export a CSV" } } });
    const run = deliverRunner({ exec: async () => ok(), github, slugOf: async () => "acme/widgets", defaultBranch: async () => "main", commitsOf: async () => ({ base: "a".repeat(40), head: "b".repeat(40) }) });
    return { run, context };
  };

  it("carries the record's goal and the base and head commits between the machine's markers", async () => {
    const github = fakeGitHub({ findPr: async () => null, openPr: async () => ({ url: "u", number: 7, isDraft: true }) });
    const { run, context } = withBody(github);
    await run(context);
    const body = (github.openPr as ReturnType<typeof vi.fn>).mock.calls[0]![1].body as string;
    expect(body.startsWith("<!-- luna:pr:start -->")).toBe(true);
    expect(body).toContain("- Readers export a CSV");
    expect(body).toContain(`Base ${"a".repeat(7)}, head ${"b".repeat(7)}`);
  });

  it("is fed the open findings, the files outside the map and each scenario's test by the context", async () => {
    const github = fakeGitHub({ findPr: async () => null, openPr: async () => ({ url: "u", number: 7, isDraft: true }) });
    const { run, context } = withBody(github);
    const finding = (title: string, severity: string) => ({ path: "a.ts", line: 2, severity, title, body: "b", confidence: 0.9 });
    const ctx = {
      ...context,
      approvals: [{ kind: "awaiting_approval", decision: "approved", requested: { cases: [{ title: "export downloads", criterion: null, approach: "a" }] } }],
      prFacts: { findings: [finding("add a test", "should_fix"), finding("rename", "nit")], outOfMap: [{ path: "docs/x.md", reason: "stale flag" }], tests: new Map([["S1", "src/export.test.ts"]]) },
    } as unknown as StageContext;
    await run(ctx);
    const body = (github.openPr as ReturnType<typeof vi.fn>).mock.calls[0]![1].body as string;
    expect(body).toContain("### should_fix\n- add a test (a.ts:2)");
    expect(body).toContain("### nit\n- rename (a.ts:2)");
    expect(body).toContain("- docs/x.md: stale flag");
    expect(body).toContain("- S1: export downloads, test `src/export.test.ts`");
  });

  it("on a PR that exists, replaces only what is between the markers and keeps a person's own text", async () => {
    const updatePrBody = vi.fn(async () => {});
    const old = "My note\n\n<!-- luna:pr:start -->\nold\n<!-- luna:pr:end -->\n\nafter";
    const github = fakeGitHub({ findPr: async () => ({ url: "u", number: 3, isDraft: true }), prFacts: async () => ({ body: old, mergeable: "MERGEABLE" }) as never, updatePrBody });
    const { run, context } = withBody(github);
    await run(context);
    const written = (updatePrBody.mock.calls[0] as unknown as [string, number, string])[2];
    expect(written.startsWith("My note\n\n<!-- luna:pr:start -->\n")).toBe(true);
    expect(written.endsWith("<!-- luna:pr:end -->\n\nafter")).toBe(true);
    expect(written).not.toContain("\nold\n");
    expect(written).toContain("Readers export a CSV");
  });
});

describe("delivering a branch that conflicts with the default branch", () => {
  const G = ["git", ...HOST_GIT, ...at("/wt")];
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

describe("pushBranch with a lease", () => {
  it("pins the lease to the sha it is given, and refuses a lease that is not a sha", async () => {
    const { pushBranch } = await import("./deliver.ts");
    const calls: string[][] = [];
    const exec = async (_c: string, args: string[]) => (args.includes("update-ref") || calls.push(args), ok());
    const sha = "a".repeat(40);
    expect(await pushBranch(exec, "hardness/t1", "/wt", { force: true, lease: sha })).toBeNull();
    expect(calls[0]).toContain(`--force-with-lease=refs/heads/hardness/t1:${sha}`);
    expect(calls[0]).not.toContain("--force-with-lease");
    expect(await pushBranch(exec, "hardness/t1", "/wt", { force: true, lease: "--upload-pack=x" })).toMatch(/lease/);
    expect(calls).toHaveLength(1);
  });
});

describe("delivering a stacked card", () => {
  const PARENT = "11111111-2222-3333-4444-555555555555";
  const SHA = "a".repeat(40);
  const MOVED = "b".repeat(40);
  const stacked = { card: { base: { card: PARENT, branch: "task/parent" } } };
  const facts = (state: "open" | "merged" | "gone", head: string | null = SHA) => async () => ({ parent: { id: PARENT, branch: "task/parent", number: 7, state, head }, defaultBranch: "main" });

  function wire(over: { facts?: () => Promise<unknown>; existing?: { url: string; number: number; isDraft: boolean } | null; current?: string; rebase?: unknown; unstack?: unknown; task?: Record<string, unknown> } = {}) {
    const pushes: string[][] = [];
    const exec = vi.fn(async (command: string, args: string[]) => {
      if (args.includes("push")) pushes.push(args);
      return ok();
    });
    const github = fakeGitHub({
      findPr: async () => over.existing ?? null,
      openPr: async () => ({ url: "https://github.com/acme/widgets/pull/9", number: 9, isDraft: true }),
      prFacts: async () => ({ number: 9, baseRefName: over.current ?? "main", mergeable: "MERGEABLE", body: "" }) as never,
      updatePrBody: async () => {},
      retargetPr: async () => {},
    });
    const rebase = vi.fn((over.rebase as never) ?? (async () => ({ ok: true as const, onto: "origin/task/parent" })));
    const unstack = vi.fn((over.unstack as never) ?? (async () => ({ ok: true as const, onto: "origin/main" })));
    const clearBase = vi.fn(async () => {});
    const stackFacts = vi.fn(over.facts ?? facts("open"));
    const run = deliverRunner({ exec, github, slugOf: async () => "acme/widgets", defaultBranch: async () => "main", stacked: { facts: stackFacts as never, clearBase, rebase: rebase as never, unstack: unstack as never, baseSha: async () => SHA } });
    const context = { task: { id: "t1", title: "part", description: "d", criteria: ["c"], branch: "task/child", worktreePath: "/wt", repoPath: "/repo", source: null, ...stacked, ...over.task } as unknown as TaskRow, stage: "delivering", attempt: 1, runId: "r1", approvals: [], signal: new AbortController().signal } as StageContext;
    return { run, context, github, pushes, rebase, unstack, clearBase, stackFacts };
  }

  it("opens its PR against the parent's branch, with the stacked line in the body", async () => {
    const { run, context, github, rebase } = wire();
    expect(await run(context)).toMatchObject({ outcome: "pass", detail: { prNumber: 9 } });
    expect(github.openPr).toHaveBeenCalledWith("acme/widgets", expect.objectContaining({ base: "task/parent", body: expect.stringContaining("Stacked on #7") }));
    expect(rebase).not.toHaveBeenCalled();
  });

  it("rebases onto the parent's new tip before it pushes, and pushes with a lease", async () => {
    const { run, context, rebase, pushes } = wire({ facts: facts("open", MOVED) });
    expect(await run(context)).toMatchObject({ outcome: "pass" });
    expect(rebase).toHaveBeenCalledTimes(1);
    expect(pushes[0]).toContain("--force-with-lease");
  });

  it("unstacks and drops the base when the parent merged, then opens against the default branch", async () => {
    const { run, context, github, unstack, clearBase, pushes } = wire({ facts: facts("merged") });
    expect(await run(context)).toMatchObject({ outcome: "pass" });
    expect(unstack).toHaveBeenCalledTimes(1);
    expect(clearBase).toHaveBeenCalledWith("t1");
    expect(pushes[0]).toContain("--force-with-lease");
    const sent = (github.openPr as unknown as { mock: { calls: Array<[string, { base?: string; body: string }]> } }).mock.calls[0]![1];
    expect(sent.base).toBeUndefined();
    expect(sent.body).not.toContain("Stacked on");
  });

  it("fails in fixed words, pushing nothing, when the parent is gone", async () => {
    const { run, context, pushes, github } = wire({ facts: facts("gone") });
    const result = await run(context);
    expect(result).toMatchObject({ outcome: "fail", detail: { escalation: "other", error: expect.stringContaining(PARENT.slice(0, 8)) } });
    expect(pushes).toEqual([]);
    expect(github.openPr).not.toHaveBeenCalled();
  });

  it("fails with the files and pushes nothing when the rebase stops", async () => {
    const { run, context, pushes } = wire({ facts: facts("open", MOVED), rebase: async () => ({ ok: false, error: "conflict", conflicts: ["a.ts"] }) });
    expect(await run(context)).toMatchObject({ outcome: "fail", detail: { conflicts: ["a.ts"], escalation: "other" } });
    expect(pushes).toEqual([]);
  });

  it("retargets an existing PR that does not target the parent's branch", async () => {
    const { run, context, github } = wire({ existing: { url: "https://github.com/acme/widgets/pull/9", number: 9, isDraft: true }, current: "main" });
    await run(context);
    expect(github.retargetPr).toHaveBeenCalledWith("acme/widgets", 9, "task/parent");
    const same = wire({ existing: { url: "https://github.com/acme/widgets/pull/9", number: 9, isDraft: true }, current: "task/parent" });
    await same.run(same.context);
    expect(same.github.retargetPr).not.toHaveBeenCalled();
  });

  it("does not touch the stack for a card with no base", async () => {
    const { run, context, stackFacts, github } = wire({ task: { card: null } });
    await run(context);
    expect(stackFacts).not.toHaveBeenCalled();
    expect((github.openPr as unknown as { mock: { calls: Array<[string, { base?: string }]> } }).mock.calls[0]![1].base).toBeUndefined();
  });
});
