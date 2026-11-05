import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ensureClone } from "./clone.ts";
import { commitAll, workspaceFor } from "./worktree.ts";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).trim();

/** A repository with one commit on `main`, and where its cards' workspaces go. */
function repository(prefix: string): { root: string; repo: string; dir: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "a\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  return { root, repo, dir: join(root, "cards") };
}

const task = { id: "11111111-2222-3333-4444-555555555555", title: "Fix it" } as never;

describe("a card's workspace is its own clone", () => {
  it("starts the card's branch at the repository's head, in a folder with its own git directory", async () => {
    const { repo, dir } = repository("clone-");
    const workspace = workspaceFor(task, repo, dir);
    await ensureClone(repo, workspace);
    expect(git(workspace.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(workspace.branch);
    expect(git(workspace.path, "rev-parse", "HEAD")).toBe(git(repo, "rev-parse", "HEAD"));
    // Its own git directory: a folder, not the `.git` file a linked worktree has.
    expect(readdirSync(join(workspace.path, ".git"))).toContain("objects");
  });

  it("shares nothing with the repository: a commit in the clone leaves the repository's branches, worktrees and objects as they were", async () => {
    const { repo, dir } = repository("clone-");
    const before = { refs: git(repo, "for-each-ref"), objects: git(repo, "count-objects", "-v"), worktrees: git(repo, "worktree", "list") };
    const workspace = workspaceFor(task, repo, dir);
    await ensureClone(repo, workspace);
    writeFileSync(join(workspace.path, "b.txt"), "b\n");
    expect(await commitAll(workspace.path, "feat: b")).toMatch(/^[0-9a-f]{40}$/);
    expect({ refs: git(repo, "for-each-ref"), objects: git(repo, "count-objects", "-v"), worktrees: git(repo, "worktree", "list") }).toEqual(before);
    // No alternates file: the clone does not read the repository's object store either.
    expect(existsSync(join(workspace.path, ".git", "objects", "info", "alternates"))).toBe(false);
  });

  it("is made once: a second call keeps the clone and what was committed in it", async () => {
    const { repo, dir } = repository("clone-");
    const workspace = workspaceFor(task, repo, dir);
    await ensureClone(repo, workspace);
    writeFileSync(join(workspace.path, "b.txt"), "b\n");
    const sha = await commitAll(workspace.path, "feat: b");
    await ensureClone(repo, workspace);
    expect(git(workspace.path, "rev-parse", "HEAD")).toBe(sha);
  });
});
