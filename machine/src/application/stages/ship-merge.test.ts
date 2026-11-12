import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { ensureClone } from "../../adapters/git/clone.ts";
import { configureMachineRepos, machineGitDir } from "../../adapters/git/machine-repo.ts";
import { fakeGitHub } from "../../test/github.ts";
import type { StageContext, StageResult } from "../ports.ts";
import type { FixDeps } from "./ship-fixes.ts";
import { mergeRound } from "./ship-merge.ts";

const ID = ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"];
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...ID, ...args], { encoding: "utf8" }).trim();
/** git on the card's workspace the way the host runs it: the machine's repository, the folder as the work tree. */
const wgit = (path: string, ...args: string[]) => execFileSync("git", ["--git-dir=" + machineGitDir(path), "--work-tree=" + path, "-C", path, ...ID, ...args], { encoding: "utf8" }).trim();

/** A repository with a bare origin, a card's workspace on `card` with its own change to `doc.md`, and `main` moved on by someone else. */
async function world(theirs: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ship-merge-")));
  configureMachineRepos(join(root, "machine-repos"));
  const remote = join(root, "remote.git");
  const repo = join(root, "repo");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  writeFileSync(join(repo, "doc.md"), "one\ntwo\nthree\n");
  writeFileSync(join(repo, "other.md"), "x\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  git(repo, "remote", "add", "origin", remote);
  git(repo, "push", "-q", "origin", "main");
  const workspace = { path: join(root, "cards", "card"), branch: "card" };
  await ensureClone(repo, workspace);
  writeFileSync(join(workspace.path, "doc.md"), "one\nTWO, the card's rewrite\nthree\n");
  wgit(workspace.path, "commit", "-q", "-am", "card: rewrite");
  wgit(workspace.path, "push", "-q", "origin", "card");
  const before = wgit(workspace.path, "rev-parse", "HEAD");
  // The default branch moves: someone else edits the same line, or another file.
  writeFileSync(join(repo, theirs === "conflict" ? "doc.md" : "new.md"), theirs === "conflict" ? "one\ntwo, and a new fact\nthree\n" : "new\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "main moves");
  git(repo, "push", "-q", "origin", "main");
  wgit(workspace.path, "fetch", "-q", "origin", "+refs/heads/main:refs/remotes/origin/main");
  const base = wgit(workspace.path, "rev-parse", "refs/remotes/origin/main");
  return { root, remote, repo, workspace, before, base };
}

function deps(w: Awaited<ReturnType<typeof world>>, resolve: ((path: string) => void) | null, checks: StageResult = { outcome: "pass" }, packCommits = true) {
  const runPack = vi.fn(async (_pack: string, context: StageContext, _extra: unknown) => {
    // The pack edits the files in the folder it is given and commits there (its commits come back like this).
    const path = context.task.worktreePath!;
    resolve?.(path);
    if (packCommits) wgit(path, "commit", "-q", "-am", "resolve the conflict");
    return { outcome: "pass", detail: { answer: { kind: "done", summary: "resolved", replies: [] } } } as StageResult;
  });
  const github = fakeGitHub({
    prHeadSha: async () => w.before,
    prFacts: async () => ({ url: "https://github.com/o/r/pull/7", title: "t", body: "", author: { login: "a" }, baseRefName: "main", headRefName: "card" }) as never,
  });
  const d = { github, loop: { decide: null, runPack, checks: vi.fn(async () => checks) }, policies: {} as never, evidence: { load: async () => null }, stateDir: w.root } as unknown as FixDeps;
  const context = { task: { id: "t1", worktreePath: w.workspace.path, branch: "card", repoPath: w.repo }, runId: "run", attempt: 1, approvals: [], signal: new AbortController().signal } as unknown as StageContext;
  return { d, context, runPack };
}

const input = (w: Awaited<ReturnType<typeof world>>) => ({ slug: "o/r", number: 7, base: { sha: w.base, name: "main" }, label: "1", pack: null });

describe("mergeRound: a branch that no longer merges", () => {
  it("merges a base that does not conflict with no pack run, pushes one merge commit and moves the card's base", async () => {
    const w = await world("clean");
    const { d, context, runPack } = deps(w, null);
    const out = await mergeRound(d, context, input(w));
    expect(out).toMatchObject({ ok: true, result: { outcome: "escalated", detail: { escalation: "head_moved", refresh: "verify" } } });
    expect(runPack).not.toHaveBeenCalled();
    const head = wgit(w.workspace.path, "rev-parse", "HEAD");
    expect(wgit(w.workspace.path, "rev-list", "--parents", "-n", "1", head).split(" ").slice(1)).toEqual([w.before, w.base]);
    expect(git(w.remote, "rev-parse", "refs/heads/card")).toBe(head);
    expect(wgit(w.workspace.path, "rev-parse", "refs/luna/base")).toBe(w.base);
  });

  it("hands a conflict to the addressing pack and ships one clean merge commit: the markers' commit is never on the branch", async () => {
    const w = await world("conflict");
    const { d, context, runPack } = deps(w, (path) => writeFileSync(join(path, "doc.md"), "one\nTWO, the card's rewrite, and a new fact\nthree\n"));
    const out = await mergeRound(d, context, input(w));
    expect(out).toMatchObject({ ok: true, resolved: ["doc.md"] });
    expect(runPack).toHaveBeenCalledTimes(1);
    const thread = (runPack.mock.calls[0]![2] as { threads: { threads: Array<{ comments: Array<{ body: string }> }> } }).threads.threads[0]!;
    expect(thread.comments[0]!.body).toContain("- doc.md");
    const head = wgit(w.workspace.path, "rev-parse", "HEAD");
    expect(wgit(w.workspace.path, "rev-list", "--parents", "-n", "1", head).split(" ").slice(1)).toEqual([w.before, w.base]);
    expect(readFileSync(join(w.workspace.path, "doc.md"), "utf8")).toBe("one\nTWO, the card's rewrite, and a new fact\nthree\n");
    expect(wgit(w.workspace.path, "log", "--format=%s", head)).not.toContain("conflicts to resolve");
    expect(git(w.remote, "rev-parse", "refs/heads/card")).toBe(head);
  });

  it("commits the pack's edits itself when the pack could not (its tool rules refuse `git -C`), and still checks them", async () => {
    const w = await world("conflict");
    const { d, context } = deps(w, (path) => writeFileSync(join(path, "doc.md"), "one\nTWO, the card's rewrite, and a new fact\nthree\n"), { outcome: "pass" }, false);
    const out = await mergeRound(d, context, input(w));
    expect(out).toMatchObject({ ok: true, resolved: ["doc.md"] });
    const head = wgit(w.workspace.path, "rev-parse", "HEAD");
    expect(wgit(w.workspace.path, "rev-list", "--parents", "-n", "1", head).split(" ").slice(1)).toEqual([w.before, w.base]);
    expect(readFileSync(join(w.workspace.path, "doc.md"), "utf8")).toBe("one\nTWO, the card's rewrite, and a new fact\nthree\n");
    expect(git(w.remote, "rev-parse", "refs/heads/card")).toBe(head);
  });

  it("does not take an uncommitted edit outside the conflicted files, or markers left in them", async () => {
    for (const [name, resolve, said] of [
      ["outside", (path: string) => { writeFileSync(join(path, "doc.md"), "one\nresolved\nthree\n"); writeFileSync(join(path, "other.md"), "sneaked\n"); }, "changed files that had no conflict (other.md)"],
      ["markers", (path: string) => writeFileSync(join(path, "doc.md"), readFileSync(join(path, "doc.md"), "utf8").replace("three", "3")), "conflict markers are left in doc.md"],
    ] as const) {
      const w = await world("conflict");
      const { d, context } = deps(w, resolve, { outcome: "pass" }, false);
      const out = await mergeRound(d, context, input(w));
      expect(out.ok, name).toBe(false);
      expect(String(out.result.detail?.reason), name).toContain(said);
      expect(git(w.remote, "rev-parse", "refs/heads/card"), name).toBe(w.before);
    }
  });

  it("says nothing was committed when the pack left the markers committed and edited nothing", async () => {
    const w = await world("conflict");
    const { d, context } = deps(w, null, { outcome: "pass" }, false);
    const out = await mergeRound(d, context, input(w));
    expect(out.ok).toBe(false);
    expect(String(out.result.detail?.reason)).toMatch(/nothing was committed/);
  });

  it("pushes nothing when markers are left, when the pack touched another file, or when the checks fail", async () => {
    for (const [name, resolve, checks, said] of [
      ["markers", (path: string) => writeFileSync(join(path, "doc.md"), readFileSync(join(path, "doc.md"), "utf8").replace("three", "3")), { outcome: "pass" }, "conflict markers are left in doc.md"],
      ["outside", (path: string) => { writeFileSync(join(path, "doc.md"), "one\nresolved\nthree\n"); writeFileSync(join(path, "other.md"), "sneaked\n"); }, { outcome: "pass" }, "changed files that had no conflict (other.md)"],
      ["checks", (path: string) => writeFileSync(join(path, "doc.md"), "one\nresolved\nthree\n"), { outcome: "fail", detail: { error: "lint failed" } }, "the checks failed after merging main: lint failed"],
    ] as const) {
      const w = await world("conflict");
      const { d, context } = deps(w, resolve, checks as StageResult);
      const out = await mergeRound(d, context, input(w));
      expect(out.ok, name).toBe(false);
      expect(String(out.result.detail?.reason), name).toContain(said);
      expect(git(w.remote, "rev-parse", "refs/heads/card"), name).toBe(w.before);
      expect(wgit(w.workspace.path, "rev-parse", "HEAD"), name).toBe(w.before);
    }
  });

  it("does not start when someone pushed to the PR", async () => {
    const w = await world("conflict");
    const { d, context, runPack } = deps(w, null);
    (d.github.prHeadSha as unknown as ReturnType<typeof vi.fn>).mockResolvedValue("f".repeat(40));
    expect(await mergeRound(d, context, input(w))).toMatchObject({ ok: false, result: { detail: { escalation: "head_moved" } } });
    expect(runPack).not.toHaveBeenCalled();
  });
});
