// A stacked card's workspace (wave 15, slice 7): cut at its parent's tip fetched from origin, diffs of its own change,
// rebased and unstacked only through the machine's repository. Real git, a bare remote as origin.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ensureClone, freshClone } from "./clone.ts";
import { taskDiff } from "./diff.ts";
import { machineGitDir } from "./machine-repo.ts";
import { exec } from "../process/exec.ts";
import { branchBase, branchDiffStat, changedPaths, commitAll, rebaseOntoBase, forgetBase, rebaseOntoDefault, stackOf, unstack, workspaceFor } from "./worktree.ts";

const cfg = ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"];
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...cfg, ...args], { encoding: "utf8" }).trim();
const wgit = (path: string, ...args: string[]) => execFileSync("git", ["--git-dir=" + machineGitDir(path), "--work-tree=" + path, "-C", path, ...cfg, ...args], { encoding: "utf8" }).trim();
const PARENT = "task/aaaaaaaa-parent";
const task = { id: "11111111-2222-3333-4444-555555555555", title: "Child" } as never;

/** A repository with a bare origin, and a parent branch of three commits pushed to origin and then forgotten locally, so a fetch is the only way to it. */
function stacked(): { root: string; repo: string; remote: string; dir: string; tip: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "stack-")));
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
  git(repo, "checkout", "-q", "-b", PARENT);
  for (const n of [1, 2, 3]) {
    writeFileSync(join(repo, `p${n}.txt`), `p${n}\n`);
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", `parent ${n}`);
  }
  const tip = git(repo, "rev-parse", "HEAD");
  git(repo, "push", "-q", "origin", PARENT);
  git(repo, "checkout", "-q", "main");
  git(repo, "branch", "-q", "-D", PARENT);
  git(repo, "update-ref", "-d", `refs/remotes/origin/${PARENT}`);
  return { root, repo, remote, dir: join(root, "cards"), tip };
}

/** The child's workspace on the parent's tip, with one commit of its own. */
async function child(s: ReturnType<typeof stacked>) {
  const workspace = workspaceFor(task, s.repo, s.dir);
  await ensureClone(s.repo, workspace, { branch: PARENT });
  writeFileSync(join(workspace.path, "c.txt"), "c\n");
  await commitAll(workspace.path, "feat: c");
  return workspace;
}

/** The parent moves on origin (a commit added, the PR's branch updated). */
function parentMoves(s: ReturnType<typeof stacked>, file = "p4.txt", content = "p4\n"): string {
  const other = join(s.root, "other");
  if (!existsSync(other)) execFileSync("git", ["clone", "-q", s.remote, other]);
  git(other, "fetch", "-q", "origin");
  git(other, "checkout", "-q", "-B", PARENT, `origin/${PARENT}`);
  writeFileSync(join(other, file), content);
  git(other, "add", "-A");
  git(other, "commit", "-q", "-m", `parent ${file}`);
  git(other, "push", "-q", "origin", PARENT);
  return git(other, "rev-parse", "HEAD");
}

describe("a stacked card's workspace", () => {
  it("starts at the parent's tip fetched from origin, and records the base commit and the branch name", async () => {
    const s = stacked();
    const workspace = await child(s);
    expect(wgit(workspace.path, "rev-parse", "refs/luna/base")).toBe(s.tip);
    expect(await stackOf(workspace.path)).toEqual({ sha: s.tip, branch: PARENT });
    expect(wgit(workspace.path, "log", "--format=%s", "-n", "2")).toBe("feat: c\nparent 3");
    expect(readFileSync(join(workspace.path, "p3.txt"), "utf8")).toBe("p3\n");
  });

  it("leaves a card with no base byte for byte as before: no ref, no key", async () => {
    const s = stacked();
    const workspace = workspaceFor(task, s.repo, s.dir);
    await ensureClone(s.repo, workspace);
    expect(await stackOf(workspace.path)).toEqual({ sha: null, branch: null });
    expect(wgit(workspace.path, "for-each-ref", "--format=%(refname)", "refs/luna")).toBe("refs/luna/pushed/base");
    expect(wgit(workspace.path, "rev-parse", "HEAD")).toBe(git(s.repo, "rev-parse", "origin/main"));
  });

  it("refuses a base name that is shaped like an option, and makes no workspace", async () => {
    const s = stacked();
    const workspace = workspaceFor(task, s.repo, s.dir);
    await expect(ensureClone(s.repo, workspace, { branch: "--upload-pack=touch /tmp/x" })).rejects.toThrow(/branch name/);
    expect(existsSync(machineGitDir(workspace.path))).toBe(false);
  });

  it("refuses a parent whose range adds a gitlink (mode 160000)", async () => {
    const s = stacked();
    const other = join(s.root, "other");
    execFileSync("git", ["clone", "-q", s.remote, other]);
    git(other, "checkout", "-q", "-b", "task/bbbbbbbb-sub", "origin/main");
    git(other, "update-index", "--add", "--cacheinfo", `160000,${s.tip},sub`);
    git(other, "commit", "-q", "-m", "a gitlink");
    git(other, "push", "-q", "origin", "task/bbbbbbbb-sub");
    const workspace = workspaceFor(task, s.repo, s.dir);
    await expect(ensureClone(s.repo, workspace, { branch: "task/bbbbbbbb-sub" })).rejects.toThrow(/160000/);
    expect(existsSync(machineGitDir(workspace.path))).toBe(false);
  });

  it("shows only the child's own change in every diff: paths, counts and the board's diff", async () => {
    const s = stacked();
    const workspace = await child(s);
    expect(await branchBase(workspace.path, s.repo)).toBe(s.tip);
    expect(await changedPaths(workspace.path, s.repo)).toEqual(["c.txt"]);
    expect(await branchDiffStat(workspace.path, s.repo)).toEqual({ added: 1, removed: 0 });
    const diff = await taskDiff(exec, workspace.path, s.repo);
    expect(diff.files.map((f) => f.path)).toEqual(["c.txt"]);
  });

  it("gives a fresh workspace the same base, so Verify diffs against the same commit", async () => {
    const s = stacked();
    const workspace = await child(s);
    const head = git(machineGitDir(workspace.path), "rev-parse", "HEAD");
    const fresh = `${workspace.path}.verify-x`;
    await freshClone(workspace.path, head, workspace.branch, fresh);
    expect(await stackOf(fresh)).toEqual({ sha: s.tip, branch: PARENT });
    expect(await changedPaths(fresh, s.repo)).toEqual(["c.txt"]);
  });
});

describe("rebasing a stacked card", () => {
  it("replays the child's commits onto the parent's new tip fetched from origin, and moves the recorded base", async () => {
    const s = stacked();
    const workspace = await child(s);
    const moved = parentMoves(s);
    const result = await rebaseOntoBase(exec, workspace.path, s.repo);
    expect(result).toEqual({ ok: true, onto: `origin/${PARENT}` });
    expect(wgit(workspace.path, "rev-parse", "refs/luna/base")).toBe(moved);
    expect(wgit(workspace.path, "log", "--format=%s", "-n", "2")).toBe("feat: c\nparent p4.txt");
    expect(await changedPaths(workspace.path, s.repo)).toEqual(["c.txt"]);
  });

  it("aborts a rebase that stops: the files are named, the folder and the recorded base are as they were", async () => {
    const s = stacked();
    const workspace = workspaceFor(task, s.repo, s.dir);
    await ensureClone(s.repo, workspace, { branch: PARENT });
    writeFileSync(join(workspace.path, "p4.txt"), "mine\n");
    await commitAll(workspace.path, "feat: mine");
    const before = wgit(workspace.path, "rev-parse", "HEAD");
    parentMoves(s, "p4.txt", "theirs\n");
    const result = await rebaseOntoBase(exec, workspace.path, s.repo);
    expect(result).toMatchObject({ ok: false, conflicts: ["p4.txt"] });
    expect(wgit(workspace.path, "rev-parse", "HEAD")).toBe(before);
    expect(wgit(workspace.path, "rev-parse", "refs/luna/base")).toBe(s.tip);
    expect(wgit(workspace.path, "status", "--porcelain")).toBe("");
    expect(existsSync(join(machineGitDir(workspace.path), "rebase-merge"))).toBe(false);
  });

  it("refuses a parent whose new commits add a gitlink, and changes nothing", async () => {
    const s = stacked();
    const workspace = await child(s);
    const other = join(s.root, "other");
    execFileSync("git", ["clone", "-q", s.remote, other]);
    git(other, "checkout", "-q", "-B", PARENT, `origin/${PARENT}`);
    git(other, "update-index", "--add", "--cacheinfo", `160000,${s.tip},sub`);
    git(other, "commit", "-q", "-m", "a gitlink");
    git(other, "push", "-q", "origin", PARENT);
    const before = wgit(workspace.path, "rev-parse", "HEAD");
    const result = await rebaseOntoBase(exec, workspace.path, s.repo);
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/160000/) });
    expect(wgit(workspace.path, "rev-parse", "HEAD")).toBe(before);
    expect(wgit(workspace.path, "rev-parse", "refs/luna/base")).toBe(s.tip);
  });

  it("does what rebaseOntoDefault did for a card with no base, and that function is the same one", async () => {
    expect(rebaseOntoDefault).toBe(rebaseOntoBase);
    const s = stacked();
    const workspace = workspaceFor(task, s.repo, s.dir);
    await ensureClone(s.repo, workspace);
    writeFileSync(join(workspace.path, "c.txt"), "c\n");
    await commitAll(workspace.path, "feat: c");
    const other = join(s.root, "other");
    execFileSync("git", ["clone", "-q", s.remote, other]);
    writeFileSync(join(other, "m.txt"), "m\n");
    git(other, "add", "-A");
    git(other, "commit", "-q", "-m", "main moves");
    git(other, "push", "-q", "origin", "main");
    // The no-base path is as it was, signing setting included: this machine's global config signs, so the test turns it off for the process.
    const keep = { n: process.env.GIT_CONFIG_COUNT, k: process.env.GIT_CONFIG_KEY_0, v: process.env.GIT_CONFIG_VALUE_0 };
    Object.assign(process.env, { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "commit.gpgsign", GIT_CONFIG_VALUE_0: "false" });
    try {
      expect(await rebaseOntoBase(exec, workspace.path, s.repo)).toEqual({ ok: true, onto: "origin/main" });
    } finally {
      for (const [name, value] of [["GIT_CONFIG_COUNT", keep.n], ["GIT_CONFIG_KEY_0", keep.k], ["GIT_CONFIG_VALUE_0", keep.v]] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
    expect(await stackOf(workspace.path)).toEqual({ sha: null, branch: null });
    expect(wgit(workspace.path, "for-each-ref", "--format=%(refname)", "refs/luna")).toBe("refs/luna/pushed/base");
  });

  it("unstacks once the parent merged: replays only the child's commits onto the default branch, moves the base there and forgets the branch", async () => {
    const s = stacked();
    const workspace = await child(s);
    // The parent squash-merges into main on origin.
    const other = join(s.root, "other");
    execFileSync("git", ["clone", "-q", s.remote, other]);
    for (const n of [1, 2, 3]) writeFileSync(join(other, `p${n}.txt`), `p${n}\n`);
    git(other, "add", "-A");
    git(other, "commit", "-q", "-m", "parent (squashed)");
    git(other, "push", "-q", "origin", "main");
    const main = git(other, "rev-parse", "HEAD");
    const result = await unstack(exec, workspace.path, s.repo);
    expect(result).toEqual({ ok: true, onto: "origin/main" });
    expect(wgit(workspace.path, "rev-parse", "refs/luna/base")).toBe(main);
    expect(await stackOf(workspace.path)).toEqual({ sha: main, branch: null });
    expect(wgit(workspace.path, "log", "--format=%s", "-n", "2")).toBe("feat: c\nparent (squashed)");
    expect(await changedPaths(workspace.path, s.repo)).toEqual(["c.txt"]);
  });

  it("leaves everything recorded as it was when unstacking stops", async () => {
    const s = stacked();
    const workspace = workspaceFor(task, s.repo, s.dir);
    await ensureClone(s.repo, workspace, { branch: PARENT });
    writeFileSync(join(workspace.path, "p9.txt"), "mine\n");
    await commitAll(workspace.path, "feat: mine");
    const other = join(s.root, "other");
    execFileSync("git", ["clone", "-q", s.remote, other]);
    writeFileSync(join(other, "p9.txt"), "theirs\n");
    git(other, "add", "-A");
    git(other, "commit", "-q", "-m", "main has p9");
    git(other, "push", "-q", "origin", "main");
    const before = wgit(workspace.path, "rev-parse", "HEAD");
    expect(await unstack(exec, workspace.path, s.repo)).toMatchObject({ ok: false, conflicts: ["p9.txt"] });
    expect(wgit(workspace.path, "rev-parse", "HEAD")).toBe(before);
    expect(await stackOf(workspace.path)).toEqual({ sha: s.tip, branch: PARENT });
  });
});

describe("a card whose parent is gone and whose PR a person retargeted", () => {
  it("forgets the recorded base: the base moves to the merge base with the default branch, the branch name goes, the commits are untouched", async () => {
    const s = stacked();
    const workspace = await child(s);
    const head = wgit(workspace.path, "rev-parse", "HEAD");
    const initial = git(s.repo, "rev-parse", "main");
    expect(await forgetBase(exec, workspace.path, s.repo)).toEqual({ ok: true, onto: "origin/main" });
    expect(wgit(workspace.path, "rev-parse", "HEAD")).toBe(head);
    expect(await stackOf(workspace.path)).toEqual({ sha: initial, branch: null });
    // The parent's commits are in the branch now: they show in its diff, which is what the reviewer must see.
    expect([...((await changedPaths(workspace.path, s.repo)) ?? [])].sort()).toEqual(["c.txt", "p1.txt", "p2.txt", "p3.txt"]);
  });

  it("changes nothing when the card has no recorded base", async () => {
    const s = stacked();
    const workspace = workspaceFor(task, s.repo, s.dir);
    await ensureClone(s.repo, workspace);
    expect(await forgetBase(exec, workspace.path, s.repo)).toMatchObject({ ok: false });
    expect(await stackOf(workspace.path)).toEqual({ sha: null, branch: null });
  });
});

describe("a hostile .git in the work folder is data to the rebase and the unstack", () => {
  const plant = (path: string, markers: string) => {
    const evil = join(path, ".evil");
    execFileSync("git", ["init", "-q", "--bare", evil]);
    execFileSync("git", ["config", "--file", join(evil, "config"), "filter.x.clean", `touch ${join(markers, "filter")}; cat`]);
    execFileSync("git", ["config", "--file", join(evil, "config"), "core.fsmonitor", `touch ${join(markers, "fsmonitor")}; echo`]);
    writeFileSync(join(path, ".gitattributes"), "* filter=x\n");
    rmSync(join(path, ".git"), { recursive: true, force: true });
    execFileSync("git", ["init", "-q", path]);
    writeFileSync(join(path, ".git", "commondir"), "../.evil\n");
    mkdirSync(join(path, ".git", "hooks"), { recursive: true });
    for (const hook of ["pre-rebase", "post-rewrite", "reference-transaction", "post-checkout"]) writeFileSync(join(path, ".git", "hooks", hook), `#!/bin/sh\ntouch ${join(markers, hook)}\n`, { mode: 0o755 });
  };

  it("runs no filter, hook or monitor of the folder's", async () => {
    const s = stacked();
    const workspace = await child(s);
    const markers = join(s.root, "markers");
    mkdirSync(markers);
    plant(workspace.path, markers);
    parentMoves(s);
    expect(await rebaseOntoBase(exec, workspace.path, s.repo)).toMatchObject({ ok: true });
    expect(await unstack(exec, workspace.path, s.repo)).toBeDefined();
    expect(existsSync(join(markers, "filter")) || existsSync(join(markers, "fsmonitor")) || existsSync(join(markers, "pre-rebase")) || existsSync(join(markers, "reference-transaction"))).toBe(false);
  });
});
