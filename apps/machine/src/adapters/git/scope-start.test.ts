// Where Build's scope is measured from once the base was merged into the branch (DISC-53): the merge round records the base's tip, and measured
// from there every file the card ever added, the tests commit's scenario tests among them, read as "changed after the tests commit".
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ensureClone } from "./clone.ts";
import { configureMachineRepos, machineGitDir } from "./machine-repo.ts";
import { BASE_REF, reformattedSince, scopeStartOf } from "./worktree.ts";

const ID = ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"];
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...ID, ...args], { encoding: "utf8" }).trim();
const wgit = (path: string, ...args: string[]) => execFileSync("git", ["--git-dir=" + machineGitDir(path), "--work-tree=" + path, "-C", path, ...ID, ...args], { encoding: "utf8" }).trim();

async function card() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "scope-start-")));
  configureMachineRepos(join(root, "machine-repos"));
  const remote = join(root, "remote.git");
  const repo = join(root, "repo");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "a\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  git(repo, "remote", "add", "origin", remote);
  git(repo, "push", "-q", "origin", "main");
  const workspace = { path: join(root, "cards", "card"), branch: "card" };
  await ensureClone(repo, workspace);
  writeFileSync(join(workspace.path, "scenario.test.ts"), "test('S1', () => {})\n");
  wgit(workspace.path, "add", "-A");
  wgit(workspace.path, "commit", "-q", "-m", "test: scenarios");
  const start = wgit(workspace.path, "rev-parse", "HEAD");
  writeFileSync(join(workspace.path, "impl.ts"), "export const x = 1\n");
  wgit(workspace.path, "add", "-A");
  wgit(workspace.path, "commit", "-q", "-m", "feat: impl");
  return { root, repo, remote, workspace, start };
}

describe("where Build's scope starts once the base was merged into the branch", () => {
  it("measures the card's own change since its start, never what the base brought or what the card added before it (DISC-53)", async () => {
    const c = await card();
    // The default branch moves; the merge round merges it into the branch and records its tip as the card's base.
    writeFileSync(join(c.repo, "develop-only.txt"), "base\n");
    git(c.repo, "add", "-A");
    git(c.repo, "commit", "-q", "-m", "main moves");
    git(c.repo, "push", "-q", "origin", "main");
    wgit(c.workspace.path, "fetch", "-q", "origin", "+refs/heads/main:refs/remotes/origin/main");
    const tip = wgit(c.workspace.path, "rev-parse", "refs/remotes/origin/main");
    wgit(c.workspace.path, "merge", "-q", "--no-ff", "-m", "Merge main into card", tip);
    wgit(c.workspace.path, "update-ref", BASE_REF, tip);
    const from = await scopeStartOf(c.workspace.path, c.repo, c.start);
    expect(wgit(c.workspace.path, "diff", "--name-only", from, "HEAD").split("\n").filter(Boolean)).toEqual(["impl.ts"]);
  });

  it("still starts at the recorded base after a rebase, where the card's start is no longer in the branch's history", async () => {
    const c = await card();
    writeFileSync(join(c.repo, "develop-only.txt"), "base\n");
    git(c.repo, "add", "-A");
    git(c.repo, "commit", "-q", "-m", "main moves");
    git(c.repo, "push", "-q", "origin", "main");
    wgit(c.workspace.path, "fetch", "-q", "origin", "+refs/heads/main:refs/remotes/origin/main");
    const tip = wgit(c.workspace.path, "rev-parse", "refs/remotes/origin/main");
    wgit(c.workspace.path, "rebase", "-q", tip);
    wgit(c.workspace.path, "update-ref", BASE_REF, tip);
    expect(await scopeStartOf(c.workspace.path, c.repo, c.start)).toBe(tip);
  });
});

describe("the tests commit's files the formatter alone changed since", () => {
  it("names a locked test only reflowed, never one whose words changed (DISC-53: Verify asked for a reflow back)", async () => {
    const c = await card();
    writeFileSync(join(c.workspace.path, "other.test.ts"), "test('S2', () => { expect(1).toBe(1) })\n");
    wgit(c.workspace.path, "add", "-A");
    wgit(c.workspace.path, "commit", "-q", "-m", "test: more scenarios");
    const tests = wgit(c.workspace.path, "rev-parse", "HEAD");
    // The formatter reflows one; the other's assertion changes.
    writeFileSync(join(c.workspace.path, "scenario.test.ts"), "test('S1', () => {})\n");
    writeFileSync(join(c.workspace.path, "other.test.ts"), "test('S2', () => {\n  expect(1).toBe(1)\n})\n");
    wgit(c.workspace.path, "add", "-A");
    wgit(c.workspace.path, "commit", "-q", "-m", "style: format");
    expect(await reformattedSince(c.workspace.path, tests)).toEqual(["other.test.ts"]);
    writeFileSync(join(c.workspace.path, "other.test.ts"), "test('S2', () => {\n  expect(1).toBe(2)\n})\n");
    wgit(c.workspace.path, "add", "-A");
    wgit(c.workspace.path, "commit", "-q", "-m", "weaken");
    expect(await reformattedSince(c.workspace.path, tests)).toEqual([]);
  });
});
