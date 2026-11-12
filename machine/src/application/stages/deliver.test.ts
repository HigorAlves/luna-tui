import { at } from "../../adapters/git/machine-repo.ts";
import { HOST_GIT } from "../../adapters/git/worktree.ts";
import { describe, expect, it, vi } from "vitest";

import type { TaskRow } from "../../domain/task.ts";
import type { ExecResult } from "../../adapters/process/exec.ts";
import { fakeGitHub } from "../../test/github.ts";
import type { StageContext } from "../ports.ts";
import { deliverRunner, parentWinsFor } from "./deliver.ts";

const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
const bad = (stderr = "nope"): ExecResult => ({ code: 1, stdout: "", stderr });

function setup(github: ReturnType<typeof fakeGitHub>, opts: { push?: ExecResult; task?: Record<string, unknown>; respond?: (args: string[]) => ExecResult | undefined; defaultBranch?: string | null; resolve?: NonNullable<Parameters<typeof deliverRunner>[0]["resolveConflicts"]> } = {}) {
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
  return { run: deliverRunner({ exec, github, slugOf: async () => "acme/widgets", defaultBranch: async () => (opts.defaultBranch === undefined ? "main" : opts.defaultBranch), ...(opts.resolve ? { resolveConflicts: opts.resolve } : {}) }), context, calls };
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

  it("says the machine has no GitHub credential when git could not ask for one, as an environment problem rather than the card's", async () => {
    for (const stderr of ["fatal: could not read Username for 'https://github.com': No such device or address", "fatal: Authentication failed for 'https://github.com/acme/widgets.git/'", "fatal: could not read Password for 'https://x@github.com': terminal prompts disabled"]) {
      const github = fakeGitHub();
      const { run, context } = setup(github, { push: bad(stderr) });
      const result = await run(context);
      expect(result.outcome).toBe("fail");
      expect(String(result.detail?.error)).toMatch(/no GitHub credential.*GH_TOKEN.*pnpm start/);
      expect(result.detail).toMatchObject({ escalation: "env_broken", envBroken: true });
      expect(github.calls).toEqual([]);
    }
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

describe("a card whose own PR already merged", () => {
  const merged = { merged: true, mergedSha: "m".repeat(40), state: "closed" as const, mergedAt: "2026-11-10T00:36:48Z" };
  const open = { merged: false, mergedSha: null, state: "open" as const, mergedAt: null };
  const squash = (extra: Record<string, unknown> = {}) => fakeGitHub({ prMerged: async () => merged, prFacts: async () => ({ baseRefName: "main" }) as never, defaultBranch: async () => "main", ...extra });

  it("ships: nothing is pushed, rebased, merged or opened, and the stage names the merge the way a person's merge is named", async () => {
    const github = squash();
    const { run, context, calls } = setup(github);
    const result = await run({ ...context, recordedPrs: [214] });
    expect(result.outcome).toBe("pass");
    expect(result.detail).toMatchObject({ merged: { sha: "m".repeat(40), at: "2026-11-10T00:36:48Z", by: "person" }, prUrl: "https://github.com/acme/widgets/pull/214", number: 214, alreadyMerged: true });
    // Only the read of the branch's head, to look for commits made after the merge (none can be told here): nothing is pushed, rebased or merged.
    expect(calls.filter((c) => !c.includes("rev-parse"))).toEqual([]);
    expect(github.openPr).not.toHaveBeenCalled();
  });

  it("looks at the newest recorded PR first, and finds the merged one among the older", async () => {
    const asked: number[] = [];
    const github = squash({ prMerged: async (_slug: string, number: number) => (asked.push(number), number === 214 ? merged : open) });
    const { run, context } = setup(github);
    const result = await run({ ...context, recordedPrs: [214, 221] });
    expect(asked).toEqual([221, 214]);
    expect(result.detail).toMatchObject({ number: 214, alreadyMerged: true });
  });

  it("goes on as before when no recorded PR is merged, or none is recorded", async () => {
    const github = fakeGitHub({ prMerged: async () => open, findPr: async () => ({ url: "https://x/pull/3", number: 3, isDraft: true }) });
    const { run, context } = setup(github);
    expect((await run({ ...context, recordedPrs: [3] })).detail).toMatchObject({ prNumber: 3, reused: true });
    expect(github.prMerged).toHaveBeenCalledTimes(1);
    const none = fakeGitHub({ findPr: async () => ({ url: "https://x/pull/3", number: 3, isDraft: true }) });
    const again = setup(none);
    expect((await again.run(again.context)).outcome).toBe("pass");
    expect(none.prMerged).not.toHaveBeenCalled();
  });

  it("is not a ship when the PR merged into another branch (a stacked card's parent)", async () => {
    const github = squash({ prFacts: async () => ({ baseRefName: "task/parent", mergeable: "MERGEABLE" }) as never, findPr: async () => ({ url: "https://x/pull/3", number: 3, isDraft: true }) });
    const { run, context } = setup(github);
    const result = await run({ ...context, recordedPrs: [214] });
    expect(result.detail).not.toHaveProperty("alreadyMerged");
    expect(result.detail).toMatchObject({ prNumber: 3 });
  });

  it("goes on when GitHub cannot say", async () => {
    const github = fakeGitHub({ prMerged: async () => { throw new Error("rate limited"); }, findPr: async () => ({ url: "https://x/pull/3", number: 3, isDraft: true }) });
    const { run, context } = setup(github);
    expect((await run({ ...context, recordedPrs: [214] })).detail).toMatchObject({ prNumber: 3 });
  });
});

describe("the draft PR's body", () => {
  const withBody = (github: ReturnType<typeof fakeGitHub>) => {
    const { context } = setup(github, { task: { record: { goal: "Readers export a CSV" } } });
    const run = deliverRunner({ exec: async () => ok(), github, slugOf: async () => "acme/widgets", defaultBranch: async () => "main", commitsOf: async () => ({ base: "a".repeat(40), head: "b".repeat(40) }) });
    return { run, context };
  };

  it("carries the record's goal between the machine's markers, and no commit shas (a reviewer has the PR's own)", async () => {
    const github = fakeGitHub({ findPr: async () => null, openPr: async () => ({ url: "u", number: 7, isDraft: true }) });
    const { run, context } = withBody(github);
    await run(context);
    const body = (github.openPr as ReturnType<typeof vi.fn>).mock.calls[0]![1].body as string;
    expect(body.startsWith("<!-- luna:pr:start -->")).toBe(true);
    expect(body).toContain("## Why\nReaders export a CSV");
    expect(body).not.toContain("a".repeat(7));
  });

  it("is fed the open findings and each scenario's test by the context, and names only what a reviewer needs", async () => {
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
    expect(body).toContain("2 findings still open: add a test (`a.ts`); rename (`a.ts`)");
    expect(body).toContain("Verify judged 1 scenario, 1 with a test written before the code");
    expect(body).not.toContain("docs/x.md");
  });

  it("follows the repository's PR template, read from its default branch", async () => {
    const github = fakeGitHub({ findPr: async () => null, openPr: async () => ({ url: "u", number: 7, isDraft: true }) });
    const { context } = withBody(github);
    const run = deliverRunner({ exec: async () => ok(), github, slugOf: async () => "acme/widgets", defaultBranch: async () => "main", commitsOf: async () => ({ base: "a".repeat(40), head: "b".repeat(40) }) , prTemplate: async () => "## Summary\n\n## Testing\n" });
    await run(context);
    const body = (github.openPr as ReturnType<typeof vi.fn>).mock.calls[0]![1].body as string;
    expect(body).toContain("## Summary\nReaders export a CSV");
    expect(body).toContain("## Testing\n");
    expect(body).not.toContain("## Why");
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
      [...G, "rev-parse", "HEAD"],
      [...G, "fetch", "--quiet", "--end-of-options", "origin", "main"],
      [...G, "rebase", "--empty=drop", "origin/main"],
      [...G, "push", "--force-with-lease", "-u", "origin", "hardness/t1"],
    ]);
  });

  it("fails naming the files when the rebase stops, after aborting it", async () => {
    const github = fakeGitHub({ findPr: async () => pr, prFacts: facts("CONFLICTING") });
    const { run, context, calls } = setup(github, {
      respond: (args) => (["rebase", "merge"].some((v) => args.includes(v)) && !args.includes("--abort") ? bad("CONFLICT") : args.includes("diff") ? ok("a.ts\nb.ts\n") : undefined),
    });
    const result = await run(context);
    expect(result.outcome).toBe("fail");
    expect(result.detail).toMatchObject({ error: "the branch conflicts with main and the rebase stopped on: a.ts, b.ts", conflicts: ["a.ts", "b.ts"], escalation: "other" });
    expect(calls).toContainEqual([...G, "diff", "--name-only", "--diff-filter=U"]);
    expect(calls).toContainEqual([...G, "rebase", "--abort"]);
    expect(calls).toContainEqual([...G, "merge", "--abort"]);
    expect(calls.some((c) => c.includes("--force-with-lease"))).toBe(false);
  });

  it("merges the default branch when the replay stops on a conflict the final result does not have, and pushes it", async () => {
    const github = fakeGitHub({ findPr: async () => pr, prFacts: facts("CONFLICTING") });
    const { run, context, calls } = setup(github, {
      respond: (args) => (args.includes("rebase") && !args.includes("--abort") ? bad("CONFLICT") : args.includes("diff") ? ok("docs/README.md\n") : undefined),
    });
    const result = await run(context);
    expect(result.outcome).toBe("pass");
    expect(result.detail).toMatchObject({ rebased: true, onto: "origin/main", merged: true });
    expect(calls.some((c) => c.includes("merge") && c.includes("--no-ff") && c.includes("origin/main"))).toBe(true);
    expect(calls.some((c) => c.includes("--force-with-lease"))).toBe(true);
  });

  describe("when the branch conflicts with the default branch for real", () => {
    const FORK = "a".repeat(40);
    const TIP = "b".repeat(40);
    /** A rebase and a merge that both stop on a.ts; the branch changed a.ts and b.ts since it forked; `same` says which of them match the default branch's version. */
    const stuck = (same: string[]) => (args: string[]): ExecResult | undefined => {
      if (["rebase", "merge"].some((v) => args.includes(v)) && !args.includes("--abort")) return bad("CONFLICT");
      if (args.includes("--diff-filter=U")) return ok("a.ts\n");
      if (args.includes("merge-base")) return ok(`${FORK}\n`);
      if (args.includes("rev-parse") && args.some((a) => a.startsWith("refs/remotes/origin/main"))) return ok(`${TIP}\n`);
      if (args.includes("diff") && args.includes("--quiet")) return same.includes(args[args.length - 1]!) ? ok() : bad("differs");
      if (args.includes("-z")) return ok("a.ts\0b.ts\0");
      return undefined;
    };

    it("says so, and runs no resolution, when every file the card changed is already identical on the default branch", async () => {
      const github = fakeGitHub({ findPr: async () => pr, prFacts: facts("CONFLICTING") });
      const resolveConflicts = vi.fn();
      const { run, context } = setup(github, { respond: stuck(["a.ts", "b.ts"]), resolve: resolveConflicts });
      const result = await run(context);
      expect(result.outcome).toBe("fail");
      expect(result.detail).toMatchObject({ escalation: "other", verdict: "already_on_base", landed: ["a.ts", "b.ts"] });
      expect(String(result.detail?.error)).toMatch(/already on main/);
      expect(resolveConflicts).not.toHaveBeenCalled();
    });

    it("hands the merge to the resolver when some files still differ, and carries on without a forced push once it lands", async () => {
      const github = fakeGitHub({ findPr: async () => pr, prFacts: facts("CONFLICTING") });
      const resolveConflicts = vi.fn(async () => ({ ok: true as const, head: "c".repeat(40), resolved: ["a.ts"], result: { outcome: "escalated" as const, detail: {} } }));
      const { run, context, calls } = setup(github, { respond: stuck(["b.ts"]), resolve: resolveConflicts });
      const result = await run(context);
      expect(resolveConflicts).toHaveBeenCalledWith(expect.objectContaining({ task: expect.objectContaining({ id: "t1" }) }), { slug: "acme/widgets", number: pr.number, base: { sha: TIP, name: "main" }, label: "deliver", pack: null });
      expect(result.outcome).toBe("pass");
      expect(result.detail).toMatchObject({ prNumber: pr.number, merged: true, resolved: ["a.ts"], onto: "origin/main" });
      expect(calls.some((c) => c.includes("--force-with-lease"))).toBe(false);
    });

    it("fails with the resolver's reason, after the same files, when the merge did not land", async () => {
      const github = fakeGitHub({ findPr: async () => pr, prFacts: facts("CONFLICTING") });
      const resolveConflicts = vi.fn(async () => ({ ok: false as const, result: { outcome: "escalated" as const, detail: { reason: "the checks failed after merging main" } } }));
      const { run, context } = setup(github, { respond: stuck([]), resolve: resolveConflicts });
      const result = await run(context);
      expect(result.outcome).toBe("fail");
      expect(result.detail).toMatchObject({ conflicts: ["a.ts"], escalation: "other" });
      expect(String(result.detail?.error)).toMatch(/rebase stopped on: a\.ts.*merging instead did not resolve it: the checks failed after merging main/);
    });

    it("asks a person as before when no resolver is wired", async () => {
      const github = fakeGitHub({ findPr: async () => pr, prFacts: facts("CONFLICTING") });
      const { run, context } = setup(github, { respond: stuck([]) });
      const result = await run(context);
      expect(result.outcome).toBe("fail");
      expect(result.detail).toMatchObject({ error: "the branch conflicts with main and the rebase stopped on: a.ts", conflicts: ["a.ts"] });
    });
  });

  it("refuses a default branch that reads as an option or is not a ref name, before any git call: the ref lives in the container-writable git dir", async () => {
    for (const base of ["--upload-pack=/g/.git/evil.sh", "-v", "a b", "", null]) {
      const github = fakeGitHub({ findPr: async () => pr, prFacts: facts("CONFLICTING") });
      const { run, context, calls } = setup(github, { defaultBranch: base });
      const result = await run(context);
      expect(result.outcome).toBe("fail");
      expect(String(result.detail?.error)).toMatch(/no usable default branch|not known from GitHub/);
      expect(calls.filter((c) => c.includes("fetch") || c.includes("rebase"))).toEqual([]);
    }
  });

  it("rebases onto the default branch GitHub names, not the host's guess", async () => {
    const github = fakeGitHub({ findPr: async () => pr, prFacts: facts("CONFLICTING"), defaultBranch: async () => "trunk" });
    const calls: string[][] = [];
    const exec = async (command: string, args: string[]) => (args.includes("update-ref") ? ok() : (calls.push([command, ...args]), ok()));
    const run = deliverRunner({ exec, github, slugOf: async () => "acme/widgets" });
    const { context } = setup(github);
    const result = await run(context);
    expect(result.outcome).toBe("pass");
    expect(calls).toContainEqual([...G, "fetch", "--quiet", "--end-of-options", "origin", "trunk"]);
    expect(calls).toContainEqual([...G, "rebase", "--empty=drop", "origin/trunk"]);
    expect(github.calls.some((c) => c.includes("acme/widgets"))).toBe(true);
  });

  it("fails in fixed words and pushes nothing more when GitHub does not say what the default branch is", async () => {
    const github = fakeGitHub({ findPr: async () => pr, prFacts: facts("CONFLICTING"), defaultBranch: async () => null });
    const calls: string[][] = [];
    const exec = async (command: string, args: string[]) => (args.includes("update-ref") ? ok() : (calls.push([command, ...args]), ok()));
    const run = deliverRunner({ exec, github, slugOf: async () => "acme/widgets" });
    const { context } = setup(github);
    const result = await run(context);
    expect(result.outcome).toBe("fail");
    expect(result.detail).toMatchObject({ error: "the default branch is not known from GitHub: nothing was rebased or pushed again", escalation: "other" });
    expect(calls.filter((c) => c.includes("fetch") || c.includes("rebase") || c.includes("--force-with-lease"))).toEqual([]);
  });

  it("fails with the push error when the push after the rebase is refused", async () => {
    const github = fakeGitHub({ findPr: async () => pr, prFacts: facts("CONFLICTING") });
    const { run, context } = setup(github, { respond: (args) => (args.includes("--force-with-lease") ? bad("stale info") : undefined) });
    const result = await run(context);
    expect(result.outcome).toBe("fail");
    expect(String(result.detail?.error)).toContain("stale info");
  });

  it("puts the branch back where it was when the forced push after the rebase fails, so the next delivery's plain push still works", async () => {
    const BEFORE = "e".repeat(40);
    const github = fakeGitHub({ findPr: async () => pr, prFacts: facts("CONFLICTING") });
    const { run, context, calls } = setup(github, {
      respond: (args) => (args.includes("rev-parse") ? ok(`${BEFORE}\n`) : args.some((a) => a.startsWith("--force-with-lease")) ? bad("could not read Username") : undefined),
    });
    const result = await run(context);
    expect(result.outcome).toBe("fail");
    expect(String(result.detail?.error)).toContain("could not read Username");
    // The lease is the head the machine pushed before, never a bare lease that a concurrent fetch can move.
    expect(calls).toContainEqual([...G, "push", `--force-with-lease=refs/heads/hardness/t1:${BEFORE}`, "-u", "origin", "hardness/t1"]);
    const reset = calls.findIndex((c) => c.includes("reset"));
    expect(calls[reset]).toEqual([...G, "reset", "--hard", "--quiet", BEFORE]);
    expect(reset).toBeGreaterThan(calls.findIndex((c) => c.some((a) => a.startsWith("--force-with-lease"))));
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

  const TIP = "c".repeat(40);
  function wire(over: { facts?: () => Promise<unknown>; existing?: { url: string; number: number; isDraft: boolean } | null; current?: string; rebase?: unknown; unstack?: unknown; task?: Record<string, unknown>; resolve?: unknown } = {}) {
    const pushes: string[][] = [];
    const exec = vi.fn(async (command: string, args: string[]) => {
      if (args.includes("push")) pushes.push(args);
      // The base's tip the merge round starts from.
      if (args.includes("rev-parse") && args.some((a) => a.startsWith("refs/remotes/origin/"))) return ok(`${TIP}\n`);
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
    const run = deliverRunner({ exec, github, slugOf: async () => "acme/widgets", defaultBranch: async () => "main", stacked: { facts: stackFacts as never, clearBase, rebase: rebase as never, unstack: unstack as never, baseSha: async () => SHA }, ...(over.resolve ? { resolveConflicts: over.resolve as never } : {}) });
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

  describe("when the move onto its base stops on a conflict", () => {
    const EXISTING = { url: "https://github.com/acme/widgets/pull/9", number: 9, isDraft: true };
    const merged = () => vi.fn(async () => ({ ok: true as const, head: "d".repeat(40), resolved: ["a.ts"], result: { outcome: "escalated" as const, detail: {} } }));

    it("hands a stopped rebase onto the parent's new tip to the merge round, against the parent's branch, and carries on", async () => {
      const resolve = merged();
      const { run, context, pushes } = wire({ facts: facts("open", MOVED), existing: EXISTING, rebase: async () => ({ ok: false, error: "conflict", conflicts: ["a.ts"] }), resolve });
      expect(await run(context)).toMatchObject({ outcome: "pass", detail: { prNumber: 9 } });
      expect(resolve).toHaveBeenCalledWith(expect.anything(), { slug: "acme/widgets", number: 9, base: { sha: TIP, name: "task/parent" }, label: "deliver-stack", pack: null });
      expect(pushes.every((p) => !p.includes("--force-with-lease"))).toBe(true);
    });

    it("hands a stopped unstack to the merge round against the default branch, then drops the base and leaves the stack", async () => {
      const resolve = merged();
      const { run, context, clearBase, github } = wire({ facts: facts("merged"), existing: EXISTING, current: "task/parent", unstack: async () => ({ ok: false, error: "conflict", conflicts: ["a.ts"] }), resolve });
      expect(await run(context)).toMatchObject({ outcome: "pass" });
      expect(resolve).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ base: { sha: TIP, name: "main" } }));
      expect(clearBase).toHaveBeenCalledWith("t1");
      expect(github.retargetPr).toHaveBeenCalledWith("acme/widgets", 9, "main");
    });

    it("fails with the files and the merge round's reason when it did not land, and pushes nothing", async () => {
      const resolve = vi.fn(async () => ({ ok: false as const, result: { outcome: "escalated" as const, detail: { reason: "the checks failed" } } }));
      const { run, context, pushes } = wire({ facts: facts("open", MOVED), existing: EXISTING, rebase: async () => ({ ok: false, error: "conflict", conflicts: ["a.ts"] }), resolve });
      const result = await run(context);
      expect(result).toMatchObject({ outcome: "fail", detail: { conflicts: ["a.ts"], escalation: "other" } });
      expect(String(result.detail?.error)).toMatch(/stopped on: a\.ts.*merging instead did not resolve it: the checks failed/);
      expect(pushes).toEqual([]);
    });

    it("asks a person as before when the card has no PR yet to merge on", async () => {
      const resolve = merged();
      const { run, context } = wire({ facts: facts("open", MOVED), rebase: async () => ({ ok: false, error: "conflict", conflicts: ["a.ts"] }), resolve });
      expect(await run(context)).toMatchObject({ outcome: "fail", detail: { conflicts: ["a.ts"] } });
      expect(resolve).not.toHaveBeenCalled();
    });
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

describe("parentWinsFor: which conflicts a stacked card's rebase settles by itself", () => {
  const gate = (touchpoints: string[]) => [{ id: "g", kind: "awaiting_approval", decision: "approved", reason: null, requested: { brief: "b", criteria: ["c"], assumptions: [], slices: [{ title: "s", est_loc: 10, touchpoints, acceptance: ["a"] }] }, response: null, createdAt: new Date(), decidedAt: new Date() }] as never;
  it("gives the parent a file the plan does not touch, and on a docs-only plan any test too", () => {
    const docs = parentWinsFor({ approvals: gate(["docs/api.md", "contracts/src/readme-ste.test.ts"]) }).parentWins!;
    expect(docs("contracts/src/readme-ste.test.ts")).toBe(true);
    expect(docs("board/README.md")).toBe(true);
    expect(docs("docs/api.md")).toBe(false);
  });
  it("keeps a planned test on a code plan the card's: that conflict needs judgement", () => {
    const code = parentWinsFor({ approvals: gate(["web/cart.ts", "web/cart.test.ts"]) }).parentWins!;
    expect(code("web/cart.test.ts")).toBe(false);
    expect(code("web/other.ts")).toBe(true);
  });
  it("settles nothing without an approved plan", () => {
    expect(parentWinsFor({ approvals: [] }).parentWins).toBeUndefined();
  });
});
