import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { copiedSettings, ensureClone, ensurePrClone, gitDirStamp, isClone, moveToClone, sealedPaths, unpushedCommits } from "./clone.ts";
import { branchBase, changedPaths, commitAll, ensureWorktree, removeWorktree, workspaceFor } from "./worktree.ts";

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

describe("what a container may not write in a clone", () => {
  it("names the config, hooks, info and object info, and every submodule's config, hooks and info, that exist", async () => {
    const { repo, dir } = repository("clone-");
    const workspace = workspaceFor(task, repo, dir);
    await ensureClone(repo, workspace);
    mkdirSync(join(workspace.path, ".git", "modules", "lib", "modules", "inner"), { recursive: true });
    writeFileSync(join(workspace.path, ".git", "modules", "lib", "config"), "");
    writeFileSync(join(workspace.path, ".git", "modules", "lib", "modules", "inner", "config"), "");
    mkdirSync(join(workspace.path, ".git", "modules", "lib", "hooks"));
    const sealed = sealedPaths(workspace.path);
    expect(sealed).toEqual(expect.arrayContaining([".git/config", ".git/hooks", ".git/info", ".git/objects/info", ".git/modules/lib/config", ".git/modules/lib/hooks", ".git/modules/lib/modules/inner/config"]));
    expect(sealed.every((p) => existsSync(join(workspace.path, p)))).toBe(true);
  });

  it("stamps the git directory, so a `.git` moved aside and replaced shows", async () => {
    const { repo, dir } = repository("clone-");
    const workspace = workspaceFor(task, repo, dir);
    await ensureClone(repo, workspace);
    const before = gitDirStamp(workspace.path);
    expect(before).toMatch(/^\d+:\d+$/);
    expect(gitDirStamp(workspace.path)).toBe(before);
    execFileSync("mv", [join(workspace.path, ".git"), join(workspace.path, ".git-aside")]);
    mkdirSync(join(workspace.path, ".git"));
    expect(gitDirStamp(workspace.path)).not.toBe(before);
  });
});

describe("a card in flight moves from a linked worktree to a clone", () => {
  it("keeps the branch, its commits and the uncommitted and untracked work; the worktree and the repository's branch go", async () => {
    const { repo, dir } = repository("move-");
    const workspace = workspaceFor(task, repo, dir);
    await ensureWorktree(repo, workspace);
    writeFileSync(join(workspace.path, "b.txt"), "b\n");
    const sha = await commitAll(workspace.path, "feat: b");
    writeFileSync(join(workspace.path, "a.txt"), "edited\n");
    writeFileSync(join(workspace.path, "new.txt"), "untracked\n");
    expect(isClone(workspace.path)).toBe(false);
    await moveToClone(repo, workspace);
    expect(isClone(workspace.path)).toBe(true);
    expect(git(workspace.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(workspace.branch);
    expect(git(workspace.path, "rev-parse", "HEAD")).toBe(sha);
    expect(git(workspace.path, "status", "--porcelain").split("\n").sort()).toEqual(["?? new.txt", "M a.txt"]);
    expect(git(repo, "worktree", "list").split("\n")).toHaveLength(1);
    expect(git(repo, "branch", "--list", workspace.branch)).toBe("");
    expect(git(repo, "rev-parse", "HEAD")).not.toBe(sha);
  });

  it("keeps the repository's branch when it holds commits the clone does not", async () => {
    const { repo, dir } = repository("move-");
    const workspace = workspaceFor(task, repo, dir);
    await ensureWorktree(repo, workspace);
    writeFileSync(join(workspace.path, "b.txt"), "b\n");
    await commitAll(workspace.path, "feat: b");
    git(workspace.path, "checkout", "-q", "--detach", "HEAD~1");
    await moveToClone(repo, workspace);
    expect(git(repo, "branch", "--list", workspace.branch)).toContain(workspace.branch);
  });

  it("does nothing to a workspace that is already a clone", async () => {
    const { repo, dir } = repository("move-");
    const workspace = workspaceFor(task, repo, dir);
    await ensureClone(repo, workspace);
    const stamp = gitDirStamp(workspace.path);
    await moveToClone(repo, workspace);
    expect(gitDirStamp(workspace.path)).toBe(stamp);
  });
});

describe("a PR task's clone", () => {
  it("is at the PR's head fetched from the remote, tracking it, and pushes go to that remote branch", async () => {
    const { repo, root, dir } = repository("pr-");
    const remote = join(root, "remote.git");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
    git(repo, "remote", "add", "origin", remote);
    git(repo, "push", "-q", "origin", "main");
    git(repo, "checkout", "-q", "-b", "feat/pr");
    writeFileSync(join(repo, "pr.txt"), "pr\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "pr");
    git(repo, "push", "-q", "origin", "feat/pr");
    const head = git(repo, "rev-parse", "HEAD");
    git(repo, "checkout", "-q", "main");
    git(repo, "branch", "-q", "-D", "feat/pr");
    const path = join(dir, "pr-clone");
    await ensurePrClone(repo, "feat/pr", path);
    expect(isClone(path)).toBe(true);
    expect(git(path, "rev-parse", "HEAD")).toBe(head);
    expect(git(path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("feat/pr");
    expect(git(path, "rev-parse", "--abbrev-ref", "@{u}")).toBe("origin/feat/pr");
    writeFileSync(join(path, "fix.txt"), "fix\n");
    await commitAll(path, "fix");
    git(path, "push", "-q");
    expect(git(remote, "rev-parse", "feat/pr")).toBe(git(path, "rev-parse", "HEAD"));
    expect(git(repo, "branch", "--list", "feat/pr")).toBe("");
  });

  it("refuses a head ref shaped like an option", async () => {
    const { repo, dir } = repository("pr-");
    await expect(ensurePrClone(repo, "--upload-pack=x", join(dir, "p"))).rejects.toThrow(/branch/);
  });
});

describe("removing a clone", () => {
  it("lists the commits no remote has, and removes a clean one from disk", async () => {
    const { repo, dir } = repository("rm-");
    const workspace = workspaceFor(task, repo, dir);
    await ensureClone(repo, workspace);
    expect(await unpushedCommits(workspace.path)).toEqual([]);
    writeFileSync(join(workspace.path, "b.txt"), "b\n");
    const sha = await commitAll(workspace.path, "feat: b");
    expect(await unpushedCommits(workspace.path)).toEqual([sha]);
    await removeWorktree(repo, workspace.path);
    expect(existsSync(workspace.path)).toBe(false);
    expect(git(repo, "for-each-ref")).not.toContain(workspace.branch);
  });
});
