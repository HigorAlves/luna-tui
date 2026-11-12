// A card whose own PR merged and that went on committing: the commits made after the merge are not in that PR. Delivering and CI must not end
// the card as shipped with them dropped. Fakes for the three outcomes (a new PR, a person asked, nothing left), real git for the replay.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { ensureClone } from "../../adapters/git/clone.ts";
import { machineGitDir } from "../../adapters/git/machine-repo.ts";
import { commitAll, workspaceFor } from "../../adapters/git/worktree.ts";
import { type ExecResult, exec as realExec } from "../../adapters/process/exec.ts";
import { buildPr } from "../../domain/prbody.ts";
import type { TaskRow } from "../../domain/task.ts";
import { fakeGitHub } from "../../test/github.ts";
import type { StageContext } from "../ports.ts";
import { ciWatchRunner } from "./ci.ts";
import { deliverRunner } from "./deliver.ts";

const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
const bad = (stderr = "nope"): ExecResult => ({ code: 1, stdout: "", stderr });
const MERGED_HEAD = "a".repeat(40);
const LOCAL_HEAD = "b".repeat(40);
const merged = { merged: true, mergedSha: "m".repeat(40), state: "closed" as const, mergedAt: "2026-11-10T00:36:48Z" };

/** The git subcommand of a call: what follows the host's pinned arguments. */
const verbOf = (args: string[]): string => args[args.findIndex((a) => a.startsWith("--work-tree=")) + 1] === "-c" ? (args[args.findIndex((a) => a === "rebase" || a === "merge") ] ?? "") : (args[args.findIndex((a) => a.startsWith("--work-tree=")) + 1] ?? "");

function setup(github: ReturnType<typeof fakeGitHub>, respond: (verb: string, args: string[]) => ExecResult | undefined, opts: { resolve?: NonNullable<Parameters<typeof deliverRunner>[0]["resolveConflicts"]> } = {}) {
  const calls: string[][] = [];
  const exec = vi.fn(async (_command: string, args: string[]) => {
    if (args.includes("update-ref")) return ok();
    calls.push(args);
    return respond(verbOf(args), args) ?? ok();
  });
  const context = {
    task: { id: "t1", title: "feat: thing", description: "d", criteria: ["c"], branch: "hardness/t1", worktreePath: "/wt", repoPath: "/repo", source: null } as unknown as TaskRow,
    stage: "delivering",
    attempt: 1,
    runId: "r1",
    approvals: [],
    recordedPrs: [214],
    signal: new AbortController().signal,
  } as StageContext;
  const run = deliverRunner({ exec, github, slugOf: async () => "acme/widgets", defaultBranch: async () => "main", prTemplate: async () => null, ...(opts.resolve ? { resolveConflicts: opts.resolve } : {}) });
  const verbs = () => calls.map(verbOf);
  return { run, context, calls, verbs, exec };
}

/** A GitHub whose PR #214 merged into main with `MERGED_HEAD` as its head. */
const githubWith = (extra: Record<string, unknown> = {}) =>
  fakeGitHub({
    prMerged: async () => merged,
    prFacts: async () => ({ baseRefName: "main" }) as never,
    defaultBranch: async () => "main",
    prHeadSha: async () => MERGED_HEAD,
    findPr: async () => null,
    openPr: async () => ({ url: "https://github.com/acme/widgets/pull/230", number: 230, isDraft: true }),
    closePr: async () => {},
    ...extra,
  });

/** A worktree whose branch has one commit after the merged head, and whose changes (a.ts landed on main, b.ts not) the base does not all hold. */
const withCommits = (verb: string, args: string[], extra: Partial<Record<string, ExecResult>> = {}): ExecResult | undefined => {
  if (extra[verb]) return extra[verb];
  if (verb === "rev-parse" && args.includes("HEAD")) return ok(LOCAL_HEAD);
  if (verb === "rev-parse") return ok("c".repeat(40));
  if (verb === "log") return ok("1234567 fix: after the merge\n");
  if (verb === "merge-base") return ok("d".repeat(40));
  if (verb === "diff" && args.includes("--name-only")) return ok("a.ts\0b.ts\0");
  if (verb === "diff" && args.includes("--quiet")) return args.includes("a.ts") ? ok() : bad("");
  if (verb === "ls-remote") return ok(`${MERGED_HEAD}\trefs/heads/hardness/t1\n`);
  return undefined;
};

describe("a merged PR and commits made after it (Deliver)", () => {
  it("with none, the card shipped: nothing is fetched, replayed, pushed or opened", async () => {
    const github = githubWith();
    const { run, context, verbs } = setup(github, (verb, args) => (verb === "rev-parse" ? ok(LOCAL_HEAD) : verb === "log" ? ok("") : withCommits(verb, args)));
    const result = await run(context);
    expect(result.detail).toMatchObject({ alreadyMerged: true, number: 214, merged: { by: "person" } });
    expect(verbs()).toEqual(["rev-parse", "log"]);
    expect(github.openPr).not.toHaveBeenCalled();
  });

  it("with some, replays only them onto the default branch, pushes with a lease and opens a new PR that follows up the merged one", async () => {
    const github = githubWith();
    const { run, context, calls } = setup(github, withCommits);
    const result = await run(context);
    expect(result.outcome).toBe("pass");
    expect(result.detail).toMatchObject({ prNumber: 230, prUrl: "https://github.com/acme/widgets/pull/230", followUpOf: 214, replayed: ["1234567 fix: after the merge"], onto: "origin/main" });
    expect(result.detail).not.toHaveProperty("alreadyMerged");
    expect(result.events?.map((e) => e.kind)).toEqual(["pr.opened", "ship.merged_with_followup"]);
    expect(result.events?.[1]?.payload).toMatchObject({ merged: 214, followUp: 230 });
    // `rebase --onto origin/main <merged head>`: the commits up to the merged head are not replayed.
    const rebase = calls.find((c) => c.includes("rebase"))!;
    expect(rebase.slice(rebase.indexOf("rebase"))).toEqual(["rebase", "--empty=drop", "--onto", "refs/remotes/origin/main", MERGED_HEAD]);
    const push = calls.find((c) => c.includes("push"))!;
    expect(push).toContain(`--force-with-lease=refs/heads/hardness/t1:${MERGED_HEAD}`);
    expect(github.openPr).toHaveBeenCalledOnce();
    const body = github.openPr.mock.calls[0]![1].body;
    expect(body).toMatch(/Follows up #214/);
  });

  it("pushes plainly when the merge deleted the branch", async () => {
    const github = githubWith();
    const { run, context, calls } = setup(github, (verb, args) => withCommits(verb, args, { "ls-remote": ok("") }));
    expect((await run(context)).outcome).toBe("pass");
    const push = calls.find((c) => c.includes("push"))!;
    expect(push.some((a) => a.startsWith("--force"))).toBe(false);
  });

  it("asks a person when the branch on GitHub holds something neither the merged PR nor the card made, and pushes nothing", async () => {
    const github = githubWith();
    const { run, context, verbs } = setup(github, (verb, args) => withCommits(verb, args, { "ls-remote": ok(`${"e".repeat(40)}\trefs/heads/hardness/t1\n`) }));
    const result = await run(context);
    expect(result.outcome).toBe("fail");
    expect(result.detail).toMatchObject({ escalation: "other", verdict: "commits_after_merge" });
    expect(verbs()).not.toContain("push");
    expect(github.openPr).not.toHaveBeenCalled();
  });

  it("when every changed file is already on the default branch as the card has it, nothing is left: the card shipped", async () => {
    const github = githubWith();
    const { run, context, verbs } = setup(github, (verb, args) => (verb === "diff" && args.includes("--quiet") ? ok() : withCommits(verb, args)));
    const result = await run(context);
    expect(result.detail).toMatchObject({ alreadyMerged: true, number: 214 });
    expect(verbs()).not.toContain("push");
    expect(github.openPr).not.toHaveBeenCalled();
  });

  it("with the merged PR's head unknown, compares the branch with the default branch by content: files left over are replayed", async () => {
    const github = githubWith({ prHeadSha: async () => { throw new Error("rate limited"); } });
    const { run, context, calls } = setup(github, (verb, args) => (verb === "ls-remote" ? ok(`${LOCAL_HEAD}\trefs/heads/hardness/t1\n`) : withCommits(verb, args)));
    const result = await run(context);
    expect(result.detail).toMatchObject({ prNumber: 230, followUpOf: 214 });
    // Without a head to cut at, the branch is rebased as a whole onto the default branch (empty commits dropped).
    expect(calls.some((c) => c.includes("rebase") && c.includes("--empty=drop") && c.includes("origin/main"))).toBe(true);
  });

  it("with the head unknown and every changed file already on the default branch, nothing is left", async () => {
    const github = githubWith({ prHeadSha: async () => null });
    const { run, context, verbs } = setup(github, (verb, args) => (verb === "diff" && args.includes("--quiet") ? ok() : withCommits(verb, args)));
    expect((await run(context)).detail).toMatchObject({ alreadyMerged: true });
    expect(verbs()).not.toContain("push");
  });

  it("asks a person, naming the commits, when the replay and the merge stop and nothing resolves them", async () => {
    const github = githubWith();
    const conflict = (verb: string, args: string[]) => {
      if (verb === "rebase") return bad("CONFLICT (content): Merge conflict in b.ts");
      if (verb === "diff" && args.includes("--diff-filter=U")) return ok("b.ts\n");
      if (verb === "merge") return bad("CONFLICT");
      return withCommits(verb, args);
    };
    const { run, context, verbs } = setup(github, conflict);
    const result = await run(context);
    expect(result.outcome).toBe("fail");
    expect(result.detail).toMatchObject({
      escalation: "other",
      verdict: "commits_after_merge",
      commits: ["1234567 fix: after the merge"],
      conflicts: ["b.ts"],
      options: ["deliver them by hand", "drop them and close the card as shipped"],
    });
    expect(String(result.detail?.error)).toContain("PR #214 merged");
    expect(String(result.detail?.error)).toContain("1234567 fix: after the merge");
    expect(result.events?.map((e) => e.kind)).toEqual(["ship.merged_followup_stuck"]);
    expect(verbs()).not.toContain("push");
    expect(github.openPr).not.toHaveBeenCalled();
  });

  it("names at most ten commits", async () => {
    const github = githubWith();
    const many = Array.from({ length: 14 }, (_, n) => `abc${String(n).padStart(4, "0")} commit ${n}`).join("\n");
    const { run, context } = setup(github, (verb, args) => (verb === "log" ? ok(many) : verb === "rebase" ? bad("CONFLICT") : verb === "diff" && args.includes("--diff-filter=U") ? ok("b.ts\n") : verb === "merge" ? bad("CONFLICT") : withCommits(verb, args)));
    const result = await run(context);
    expect(result.detail?.commits).toHaveLength(10);
    expect(String(result.detail?.error)).toContain("and 4 more");
  });

  it("hands a replay that stopped to the merge round on the new PR, and goes on when the round lands it", async () => {
    const github = githubWith();
    const resolve = vi.fn(async () => ({ ok: true as const, head: "h".repeat(40), resolved: ["b.ts"], result: { outcome: "pass" as const } }));
    const conflict = (verb: string, args: string[]) => (verb === "rebase" ? bad("CONFLICT") : verb === "diff" && args.includes("--diff-filter=U") ? ok("b.ts\n") : verb === "merge" ? bad("CONFLICT") : withCommits(verb, args));
    const { run, context } = setup(github, conflict, { resolve });
    const result = await run(context);
    expect(result.outcome).toBe("pass");
    expect(result.detail).toMatchObject({ prNumber: 230, followUpOf: 214, merged: true, resolved: ["b.ts"] });
    expect(resolve).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ slug: "acme/widgets", number: 230, label: "deliver-followup", base: { sha: "c".repeat(40), name: "main" } }));
  });

  it("closes the PR it opened and asks a person when the merge round cannot land the commits", async () => {
    const github = githubWith();
    const resolve = vi.fn(async () => ({ ok: false as const, result: { outcome: "fail" as const, detail: { reason: "the checks failed on the merge" } } }));
    const conflict = (verb: string, args: string[]) => (verb === "rebase" ? bad("CONFLICT") : verb === "diff" && args.includes("--diff-filter=U") ? ok("b.ts\n") : verb === "merge" ? bad("CONFLICT") : withCommits(verb, args));
    const { run, context } = setup(github, conflict, { resolve });
    const result = await run(context);
    expect(result.outcome).toBe("fail");
    expect(result.detail).toMatchObject({ escalation: "other", verdict: "commits_after_merge", options: ["deliver them by hand", "drop them and close the card as shipped"] });
    expect(String(result.detail?.error)).toContain("the checks failed on the merge");
    expect(github.closePr).toHaveBeenCalledWith("acme/widgets", 230);
  });

  it("restores the branch when the lease push is refused", async () => {
    const github = githubWith();
    const { run, context, calls } = setup(github, (verb, args) => (verb === "push" ? bad("stale info") : withCommits(verb, args)));
    const result = await run(context);
    expect(result.outcome).toBe("fail");
    expect(calls.some((c) => c.includes("reset") && c.includes(LOCAL_HEAD))).toBe(true);
    expect(github.openPr).not.toHaveBeenCalled();
  });

  it("goes on as a plain delivery once the follow-up PR is open: the merged PR is not the card's any more", async () => {
    const github = githubWith({ findPr: async () => ({ url: "https://github.com/acme/widgets/pull/230", number: 230, isDraft: true }), prFacts: async () => ({ baseRefName: "main", mergeable: "MERGEABLE", body: "" }) as never, updatePrBody: async () => {} });
    const { run, context } = setup(github, withCommits);
    const result = await run({ ...context, recordedPrs: [214, 230] });
    expect(result.detail).toMatchObject({ prNumber: 230, reused: true });
    expect(result.detail).not.toHaveProperty("alreadyMerged");
    expect(github.openPr).not.toHaveBeenCalled();
  });
});

describe("a merged PR and commits made after it (CI watch)", () => {
  it("opens the follow-up PR and watches its checks, carrying the events of the new PR on the result", async () => {
    const github = githubWith({ prChecks: async () => [{ name: "lint", state: "SUCCESS", link: null }] });
    const calls: string[][] = [];
    const exec = vi.fn(async (_c: string, args: string[]) => {
      if (args.includes("update-ref")) return ok();
      calls.push(args);
      return withCommits(verbOf(args), args) ?? ok();
    });
    const run = ciWatchRunner({ github, runPack: async () => ({ outcome: "pass" }), slugOf: async () => "acme/widgets", parentRef: async () => null, graceMs: 0, pollMs: 1, maxWaitMs: 100, exec, sleep: async () => {} });
    const context = { task: { id: "t1", title: "feat: thing", description: "d", criteria: ["c"], branch: "hardness/t1", worktreePath: "/wt", repoPath: "/repo", source: null } as unknown as TaskRow, stage: "ci_watch", attempt: 1, runId: "r1", approvals: [], recordedPrs: [214], signal: new AbortController().signal } as StageContext;
    const result = await run(context);
    expect(result.outcome).toBe("pass");
    expect(result.detail).not.toHaveProperty("alreadyMerged");
    expect(result.events?.map((e) => e.kind)).toEqual(["pr.opened", "ship.merged_with_followup"]);
    expect(github.openPr).toHaveBeenCalledOnce();
    expect(github.prChecks).toHaveBeenCalled();
  });

  it("ends the stage with the escalation when nothing applies the commits", async () => {
    const github = githubWith();
    const exec = vi.fn(async (_c: string, args: string[]) => {
      if (args.includes("update-ref")) return ok();
      const verb = verbOf(args);
      if (verb === "rebase") return bad("CONFLICT");
      if (verb === "diff" && args.includes("--diff-filter=U")) return ok("b.ts\n");
      if (verb === "merge") return bad("CONFLICT");
      return withCommits(verb, args) ?? ok();
    });
    const run = ciWatchRunner({ github, runPack: async () => ({ outcome: "pass" }), slugOf: async () => "acme/widgets", exec, sleep: async () => {} });
    const context = { task: { id: "t1", title: "feat: thing", description: "d", criteria: ["c"], branch: "hardness/t1", worktreePath: "/wt", repoPath: "/repo", source: null } as unknown as TaskRow, stage: "ci_watch", attempt: 1, runId: "r1", approvals: [], recordedPrs: [214], signal: new AbortController().signal } as StageContext;
    const result = await run(context);
    expect(result.outcome).toBe("fail");
    expect(result.detail).toMatchObject({ escalation: "other", verdict: "commits_after_merge" });
  });
});

describe("the follow-up PR's body", () => {
  it("says which merged PR it follows up", () => {
    const task = { id: "t1", title: "fix: later", description: "d", criteria: [], source: null, record: null } as unknown as TaskRow;
    const { body } = buildPr({ task, plan: null, repoSlug: "acme/widgets", extra: { followsUp: 214 } });
    expect(body).toMatch(/Follows up #214/);
    expect(buildPr({ task, plan: null, repoSlug: "acme/widgets" }).body).not.toMatch(/Follows up/);
  });
});

// Real git: a bare origin, the card's workspace (the machine's own repository for it), a squash of the card's PR on main, then a commit after the merge.
const cfg = ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"];
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...cfg, ...args], { encoding: "utf8" }).trim();
const wgit = (path: string, ...args: string[]) => execFileSync("git", ["--git-dir=" + machineGitDir(path), "--work-tree=" + path, "-C", path, ...cfg, ...args], { encoding: "utf8" }).trim();
const cardTask = { id: "11111111-2222-3333-4444-555555555555", title: "Card" } as never;

async function mergedCard() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "post-merge-")));
  const repo = join(root, "repo");
  const remote = join(root, "remote.git");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "a\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  git(repo, "remote", "add", "origin", remote);
  git(repo, "push", "-q", "origin", "main");
  git(repo, "fetch", "-q", "origin");
  git(repo, "remote", "set-head", "origin", "main");
  const workspace = workspaceFor(cardTask, repo, join(root, "cards"));
  await ensureClone(repo, workspace);
  writeFileSync(join(workspace.path, "c.txt"), "c\n");
  await commitAll(workspace.path, "feat: c");
  wgit(workspace.path, "push", "-q", "-u", "origin", workspace.branch);
  const mergedHead = wgit(workspace.path, "rev-parse", "HEAD");
  // The person's squash merge: the card's content in one new commit on main, the card's own commit nowhere in main's history.
  const other = join(root, "other");
  execFileSync("git", ["clone", "-q", remote, other]);
  writeFileSync(join(other, "c.txt"), "c\n");
  git(other, "add", "-A");
  git(other, "commit", "-q", "-m", "feat: c (#214)");
  git(other, "push", "-q", "origin", "main");
  return { root, remote, other, workspace, mergedHead };
}

const realRun = (card: Awaited<ReturnType<typeof mergedCard>>, github: ReturnType<typeof fakeGitHub>, resolveConflicts?: Parameters<typeof deliverRunner>[0]["resolveConflicts"]) => {
  const context = {
    task: { id: "t1", title: "fix: later", description: "d", criteria: ["c"], branch: card.workspace.branch, worktreePath: card.workspace.path, repoPath: join(card.root, "repo"), source: null } as unknown as TaskRow,
    stage: "delivering",
    attempt: 1,
    runId: "r1",
    approvals: [],
    recordedPrs: [214],
    signal: new AbortController().signal,
  } as StageContext;
  return { context, run: deliverRunner({ exec: realExec, github, slugOf: async () => "acme/widgets", defaultBranch: async () => "main", prTemplate: async () => null, ...(resolveConflicts ? { resolveConflicts } : {}) }) };
};

describe("a merged PR and a commit made after it, in real git", () => {
  it("pushes the branch with only the later commit on top of main, and opens a PR for it", async () => {
    const card = await mergedCard();
    writeFileSync(join(card.workspace.path, "d.txt"), "d\n");
    await commitAll(card.workspace.path, "fix: d");
    const github = githubWith({ prHeadSha: async () => card.mergedHead });
    const { run, context } = realRun(card, github);
    const result = await run(context);
    expect(result.outcome).toBe("pass");
    expect(result.detail).toMatchObject({ prNumber: 230, followUpOf: 214, replayed: [expect.stringMatching(/ fix: d$/)] });
    const head = wgit(card.workspace.path, "rev-parse", "HEAD");
    expect(git(card.remote, "rev-parse", `refs/heads/${card.workspace.branch}`)).toBe(head);
    // On the new base: main's squash, then only the later commit; the card's merged commit is not replayed.
    expect(git(card.remote, "log", "--format=%s", `main..refs/heads/${card.workspace.branch}`)).toBe("fix: d");
    expect(wgit(card.workspace.path, "status", "--porcelain")).toBe("");
  });

  it("with no commit after the merge, the card shipped and nothing is pushed", async () => {
    const card = await mergedCard();
    const before = git(card.remote, "rev-parse", `refs/heads/${card.workspace.branch}`);
    const github = githubWith({ prHeadSha: async () => card.mergedHead });
    const { run, context } = realRun(card, github);
    const result = await run(context);
    expect(result.detail).toMatchObject({ alreadyMerged: true, number: 214 });
    expect(git(card.remote, "rev-parse", `refs/heads/${card.workspace.branch}`)).toBe(before);
    expect(github.openPr).not.toHaveBeenCalled();
  });

  it("with a later commit that conflicts with main, leaves the worktree as it was and asks a person with the commit named", async () => {
    const card = await mergedCard();
    // Main moved on in the same file the later commit edits.
    writeFileSync(join(card.other, "c.txt"), "c\nmain moved\n");
    git(card.other, "add", "-A");
    git(card.other, "commit", "-q", "-m", "chore: more");
    git(card.other, "push", "-q", "origin", "main");
    writeFileSync(join(card.workspace.path, "c.txt"), "c\nlater\n");
    await commitAll(card.workspace.path, "fix: later c");
    const before = wgit(card.workspace.path, "rev-parse", "HEAD");
    const github = githubWith({ prHeadSha: async () => card.mergedHead });
    const { run, context } = realRun(card, github);
    const result = await run(context);
    expect(result.outcome).toBe("fail");
    expect(result.detail).toMatchObject({ escalation: "other", verdict: "commits_after_merge", conflicts: ["c.txt"], commits: [expect.stringMatching(/ fix: later c$/)] });
    expect(wgit(card.workspace.path, "rev-parse", "HEAD")).toBe(before);
    expect(wgit(card.workspace.path, "status", "--porcelain")).toBe("");
    expect(github.openPr).not.toHaveBeenCalled();
    expect(git(card.remote, "rev-parse", `refs/heads/${card.workspace.branch}`)).toBe(card.mergedHead);
  });

  it("with the merged PR's head unknown, compares by content: the card's own squashed content alone is nothing left", async () => {
    const card = await mergedCard();
    const github = githubWith({ prHeadSha: async () => null });
    const { run, context } = realRun(card, github);
    expect((await run(context)).detail).toMatchObject({ alreadyMerged: true });
  });
});

