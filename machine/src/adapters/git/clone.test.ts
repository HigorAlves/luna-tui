import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { copiedSettings, ensureClone, isClone } from "./clone.ts";
import { branchBase, changedPaths, commitAll, workspaceFor } from "./worktree.ts";

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

describe("a clone reaches the repository's remote and nothing else of its config", () => {
  it("keeps the repository's origin and push url, and the settings a push needs", async () => {
    const { repo, dir, root } = repository("clone-");
    const remote = join(root, "remote.git");
    execFileSync("git", ["init", "-q", "--bare", remote]);
    git(repo, "remote", "add", "origin", remote);
    git(repo, "remote", "set-url", "--push", "origin", `${remote}-push`);
    git(repo, "config", "credential.helper", "store");
    git(repo, "config", "core.sshCommand", "ssh -i k");
    git(repo, "config", "url.https://x/.insteadOf", "x:");
    git(repo, "config", "core.fsmonitor", "touch /tmp/never");
    git(repo, "config", "alias.st", "status");
    const workspace = workspaceFor(task, repo, dir);
    await ensureClone(repo, workspace);
    expect(git(workspace.path, "remote", "get-url", "origin")).toBe(remote);
    expect(git(workspace.path, "remote", "get-url", "--push", "origin")).toBe(`${remote}-push`);
    expect(git(workspace.path, "config", "--local", "credential.helper")).toBe("store");
    expect(git(workspace.path, "config", "--local", "core.sshCommand")).toBe("ssh -i k");
    expect(git(workspace.path, "config", "--local", "url.https://x/.insteadOf")).toBe("x:");
    const keys = (await copiedSettings(repo)).map(([k]) => k);
    expect(keys).not.toContain("core.fsmonitor");
    expect(git(workspace.path, "config", "--local", "--list")).not.toMatch(/fsmonitor|alias/);
    expect(isClone(workspace.path)).toBe(true);
  });

  it("uses the repository's path as origin when it has no remote", async () => {
    const { repo, dir } = repository("clone-");
    const workspace = workspaceFor(task, repo, dir);
    await ensureClone(repo, workspace);
    expect(git(workspace.path, "remote", "get-url", "origin")).toBe(repo);
  });

  it("answers branchBase and changedPaths as a worktree did, even after the repository moved on", async () => {
    const { repo, dir } = repository("clone-");
    const workspace = workspaceFor(task, repo, dir);
    await ensureClone(repo, workspace);
    const fork = git(repo, "rev-parse", "HEAD");
    writeFileSync(join(workspace.path, "b.txt"), "b\n");
    await commitAll(workspace.path, "feat: b");
    writeFileSync(join(repo, "c.txt"), "c\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "later");
    expect(await branchBase(workspace.path, repo)).toBe(fork);
    expect(await changedPaths(workspace.path, repo)).toEqual(["b.txt"]);
  });
});
