import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { bringBack, copiedSettings, ensureClone, ensurePrClone, freshClone, isClone, moveToClone, publishBranch, removeClone, unpushedCommits } from "./clone.ts";
import { machineGitDir } from "./machine-repo.ts";
import { branchBase, changedPaths, commitAll, ensureWorktree, removeWorktree, workspaceFor } from "./worktree.ts";

const base = ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"];
/** git in a repository of the user's. */
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...base, ...args], { encoding: "utf8" }).trim();
/** git on a card's workspace, the way the host runs it. */
const wgit = (path: string, ...args: string[]) => execFileSync("git", ["--git-dir=" + machineGitDir(path), "--work-tree=" + path, "-C", path, ...base, ...args], { encoding: "utf8" }).trim();

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

/** The same with a bare remote as origin. */
function withRemote(prefix: string) {
  const r = repository(prefix);
  const remote = join(r.root, "remote.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  git(r.repo, "remote", "add", "origin", remote);
  git(r.repo, "push", "-q", "origin", "main");
  return { ...r, remote };
}

const task = { id: "11111111-2222-3333-4444-555555555555", title: "Fix it" } as never;

describe("a card's workspace is a folder and a repository of the machine's", () => {
  it("starts the card's branch at the repository's head, with the files checked out and no .git of its own in the folder", async () => {
    const { repo, dir } = repository("clone-");
    const workspace = workspaceFor(task, repo, dir);
    await ensureClone(repo, workspace);
    expect(wgit(workspace.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(workspace.branch);
    expect(wgit(workspace.path, "rev-parse", "HEAD")).toBe(git(repo, "rev-parse", "HEAD"));
    expect(readFileSync(join(workspace.path, "a.txt"), "utf8")).toBe("a\n");
    expect(existsSync(join(workspace.path, ".git"))).toBe(false);
    expect(machineGitDir(workspace.path).startsWith(workspace.path)).toBe(false);
    expect(isClone(workspace.path)).toBe(true);
  });

  it("shares nothing with the user's repository: a commit leaves its branches, worktrees and objects as they were, and there is no alternates file", async () => {
    const { repo, dir } = repository("clone-");
    const before = { refs: git(repo, "for-each-ref"), objects: git(repo, "count-objects", "-v"), worktrees: git(repo, "worktree", "list") };
    const workspace = workspaceFor(task, repo, dir);
    await ensureClone(repo, workspace);
    writeFileSync(join(workspace.path, "b.txt"), "b\n");
    expect(await commitAll(workspace.path, "feat: b")).toMatch(/^[0-9a-f]{40}$/);
    expect({ refs: git(repo, "for-each-ref"), objects: git(repo, "count-objects", "-v"), worktrees: git(repo, "worktree", "list") }).toEqual(before);
    // History is borrowed in place from the user's repository (read through, never written); the card's own objects are its own.
    expect(readFileSync(join(machineGitDir(workspace.path), "objects", "info", "alternates"), "utf8").trim()).toBe(join(repo, ".git", "objects"));
    expect(git(machineGitDir(workspace.path), "count-objects", "-v")).toMatch(/count: [1-9]|in-pack: 0/);
  });

  it("is made once: a second call keeps the workspace and what was committed in it, and a lost folder is checked out again", async () => {
    const { repo, dir } = repository("clone-");
    const workspace = workspaceFor(task, repo, dir);
    await ensureClone(repo, workspace);
    writeFileSync(join(workspace.path, "b.txt"), "b\n");
    const sha = await commitAll(workspace.path, "feat: b");
    await ensureClone(repo, workspace);
    expect(wgit(workspace.path, "rev-parse", "HEAD")).toBe(sha);
    removeFolderOnly(workspace.path);
    await ensureClone(repo, workspace);
    expect(readFileSync(join(workspace.path, "b.txt"), "utf8")).toBe("b\n");
  });

  it("has origin at the repository's remote and push url, with the settings a push needs and nothing else of its config", async () => {
    const { repo, dir, root, remote } = withRemote("clone-");
    git(repo, "remote", "set-url", "--push", "origin", `${remote}-push`);
    git(repo, "config", "credential.helper", "store");
    git(repo, "config", "core.sshCommand", "ssh -i k");
    git(repo, "config", "url.https://x/.insteadOf", "x:");
    git(repo, "config", "core.fsmonitor", "touch /tmp/never");
    git(repo, "config", "alias.st", "status");
    const workspace = workspaceFor(task, repo, dir);
    await ensureClone(repo, workspace);
    expect(wgit(workspace.path, "remote", "get-url", "origin")).toBe(remote);
    expect(wgit(workspace.path, "remote", "get-url", "--push", "origin")).toBe(`${remote}-push`);
    expect(wgit(workspace.path, "config", "--local", "credential.helper")).toBe("store");
    expect(wgit(workspace.path, "config", "--local", "core.sshCommand")).toBe("ssh -i k");
    expect(wgit(workspace.path, "config", "--local", "url.https://x/.insteadOf")).toBe("x:");
    expect((await copiedSettings(["-C", repo])).map(([k]) => k)).not.toContain("core.fsmonitor");
    expect(wgit(workspace.path, "config", "--local", "--list")).not.toMatch(/fsmonitor|alias/);
    expect(root).toBeTruthy();
  });

  it("uses the repository's path as origin when it has no remote", async () => {
    const { repo, dir } = repository("clone-");
    const workspace = workspaceFor(task, repo, dir);
    await ensureClone(repo, workspace);
    expect(wgit(workspace.path, "remote", "get-url", "origin")).toBe(repo);
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

function removeFolderOnly(path: string): void {
  execFileSync("rm", ["-rf", path]);
}

describe("a card in flight moves from a linked worktree to a workspace of its own", () => {
  it("keeps the branch, its commits and the uncommitted and untracked work; the worktree and the repository's branch go", async () => {
    const { repo, dir } = repository("move-");
    const workspace = workspaceFor(task, repo, dir);
    await ensureWorktree(repo, workspace);
    writeFileSync(join(workspace.path, "b.txt"), "b\n");
    git(workspace.path, "add", "-A");
    git(workspace.path, "commit", "-q", "-m", "feat: b");
    const sha = git(workspace.path, "rev-parse", "HEAD");
    writeFileSync(join(workspace.path, "a.txt"), "edited\n");
    writeFileSync(join(workspace.path, "new.txt"), "untracked\n");
    expect(isClone(workspace.path)).toBe(false);
    await moveToClone(repo, workspace);
    expect(isClone(workspace.path)).toBe(true);
    expect(existsSync(join(workspace.path, ".git"))).toBe(false);
    expect(wgit(workspace.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(workspace.branch);
    expect(wgit(workspace.path, "rev-parse", "HEAD")).toBe(sha);
    expect(wgit(workspace.path, "status", "--porcelain").split("\n").sort()).toEqual(["?? new.txt", "M a.txt"]);
    expect(git(repo, "worktree", "list").split("\n")).toHaveLength(1);
    expect(git(repo, "branch", "--list", workspace.branch)).toBe("");
  });

  it("keeps the repository's branch when it holds commits the workspace does not", async () => {
    const { repo, dir } = repository("move-");
    const workspace = workspaceFor(task, repo, dir);
    await ensureWorktree(repo, workspace);
    writeFileSync(join(workspace.path, "b.txt"), "b\n");
    git(workspace.path, "add", "-A");
    git(workspace.path, "commit", "-q", "-m", "feat: b");
    git(workspace.path, "checkout", "-q", "--detach", "HEAD~1");
    await moveToClone(repo, workspace);
    expect(git(repo, "branch", "--list", workspace.branch)).toContain(workspace.branch);
  });

  it("does nothing to a workspace that already is one", async () => {
    const { repo, dir } = repository("move-");
    const workspace = workspaceFor(task, repo, dir);
    await ensureClone(repo, workspace);
    const head = wgit(workspace.path, "rev-parse", "HEAD");
    writeFileSync(join(workspace.path, "w.txt"), "w\n");
    await moveToClone(repo, workspace);
    expect(wgit(workspace.path, "rev-parse", "HEAD")).toBe(head);
    expect(existsSync(join(workspace.path, "w.txt"))).toBe(true);
  });
});

describe("a PR task's workspace", () => {
  it("is at the PR's head fetched from the remote, tracking it, and pushes go to that remote branch", async () => {
    const { repo, dir, remote } = withRemote("pr-");
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
    expect(wgit(path, "rev-parse", "HEAD")).toBe(head);
    expect(wgit(path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("feat/pr");
    expect(wgit(path, "rev-parse", "--abbrev-ref", "@{u}")).toBe("origin/feat/pr");
    writeFileSync(join(path, "fix.txt"), "fix\n");
    await commitAll(path, "fix");
    wgit(path, "push", "-q");
    expect(git(remote, "rev-parse", "feat/pr")).toBe(wgit(path, "rev-parse", "HEAD"));
    expect(git(repo, "branch", "--list", "feat/pr")).toBe("");
  });

  it("refuses a head ref shaped like an option", async () => {
    const { repo, dir } = repository("pr-");
    await expect(ensurePrClone(repo, "--upload-pack=x", join(dir, "p"))).rejects.toThrow(/branch/);
  });
});

describe("what was pushed, and removing a workspace", () => {
  it("lists the commits the machine has not pushed, by what it recorded itself, and removes the folder and its repository", async () => {
    const { repo, dir } = repository("rm-");
    const workspace = workspaceFor(task, repo, dir);
    await ensureClone(repo, workspace);
    expect(await unpushedCommits(workspace.path)).toEqual([]);
    writeFileSync(join(workspace.path, "b.txt"), "b\n");
    const sha = await commitAll(workspace.path, "feat: b");
    expect(await unpushedCommits(workspace.path)).toEqual([sha]);
    wgit(workspace.path, "update-ref", `refs/luna/pushed/${workspace.branch}`, "HEAD");
    expect(await unpushedCommits(workspace.path)).toEqual([]);
    writeFileSync(join(workspace.path, "c.txt"), "c\n");
    const second = await commitAll(workspace.path, "feat: c");
    expect(await unpushedCommits(workspace.path)).toEqual([second]);
    await removeWorktree(repo, workspace.path);
    expect(existsSync(workspace.path)).toBe(false);
    expect(existsSync(machineGitDir(workspace.path))).toBe(false);
  });

  it("does not take a ref a container could write as proof that a commit was pushed", async () => {
    const { repo, dir } = repository("rm-");
    const workspace = workspaceFor(task, repo, dir);
    await ensureClone(repo, workspace);
    writeFileSync(join(workspace.path, "b.txt"), "b\n");
    const sha = await commitAll(workspace.path, "feat: b");
    // What a container can do to its own folder: plant a repository whose refs say everything was pushed.
    execFileSync("git", ["init", "-q", workspace.path]);
    git(workspace.path, "commit", "--allow-empty", "-q", "-m", "planted");
    git(workspace.path, "update-ref", "refs/luna/pushed/anything", "HEAD");
    expect(await unpushedCommits(workspace.path)).toContain(sha);
    removeClone(workspace.path);
  });
});

describe("a fresh workspace for Verify and fixes", () => {
  const card = async () => {
    const { repo, root, dir, remote } = withRemote("fresh-");
    const workspace = workspaceFor(task, repo, dir);
    await ensureClone(repo, workspace);
    writeFileSync(join(workspace.path, "b.txt"), "b\n");
    const sha = (await commitAll(workspace.path, "feat: b"))!;
    return { repo, root, remote, workspace, sha };
  };

  it("is a new folder at exactly that commit, on the card's branch, with the card's remote, its own repository and nothing shared", async () => {
    const { root, remote, workspace, sha } = await card();
    writeFileSync(join(workspace.path, "later.txt"), "x\n");
    await commitAll(workspace.path, "feat: later");
    const path = join(root, "verify-clone");
    await freshClone(workspace.path, sha, workspace.branch, path);
    expect(wgit(path, "rev-parse", "HEAD")).toBe(sha);
    expect(wgit(path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(workspace.branch);
    expect(wgit(path, "remote", "get-url", "origin")).toBe(remote);
    expect(machineGitDir(path)).not.toBe(machineGitDir(workspace.path));
    expect(readFileSync(join(machineGitDir(path), "objects", "info", "alternates"), "utf8").trim()).toBe(join(machineGitDir(workspace.path), "objects"));
    expect(existsSync(join(path, "later.txt"))).toBe(false);
    expect(existsSync(join(path, ".git"))).toBe(false);
  });

  it("refuses a revision that is not a full commit id", async () => {
    const { root, workspace } = await card();
    await expect(freshClone(workspace.path, "HEAD", workspace.branch, join(root, "v"))).rejects.toThrow(/commit/);
  });

  it("brings back what was committed there only as a fast-forward of the card's branch, with the files", async () => {
    const { root, workspace, sha } = await card();
    const path = join(root, "verify-clone");
    await freshClone(workspace.path, sha, workspace.branch, path);
    writeFileSync(join(path, "t.test.ts"), "t\n");
    const added = (await commitAll(path, "test: more"))!;
    expect(await bringBack(workspace.path, path, workspace.branch, sha)).toEqual({ ok: true, head: added });
    expect(wgit(workspace.path, "rev-parse", "HEAD")).toBe(added);
    expect(existsSync(join(workspace.path, "t.test.ts"))).toBe(true);
  });

  it("brings nothing back when the card moved on, or when the fresh history was rewritten, and nothing when there is nothing", async () => {
    const { root, workspace, sha } = await card();
    const path = join(root, "verify-clone");
    await freshClone(workspace.path, sha, workspace.branch, path);
    wgit(path, "reset", "-q", "--hard", "HEAD~1");
    writeFileSync(join(path, "other.txt"), "o\n");
    await commitAll(path, "rewrite");
    const before = wgit(workspace.path, "rev-parse", "HEAD");
    expect(await bringBack(workspace.path, path, workspace.branch, sha)).toMatchObject({ ok: false });
    expect(wgit(workspace.path, "rev-parse", "HEAD")).toBe(before);
    const same = join(root, "same");
    await freshClone(workspace.path, sha, workspace.branch, same);
    expect(await bringBack(workspace.path, same, workspace.branch, sha)).toEqual({ ok: true, head: sha });
    writeFileSync(join(workspace.path, "moved.txt"), "m\n");
    await commitAll(workspace.path, "card moved");
    expect(await bringBack(workspace.path, path, workspace.branch, sha)).toMatchObject({ ok: false, reason: expect.stringContaining("no longer") });
  });
});

describe("the card's branch in the user's repository", () => {
  it("shows up there as the same branch, written by the machine, and follows each commit", async () => {
    const { repo, dir } = repository("publish-");
    const workspace = workspaceFor(task, repo, dir);
    await ensureClone(repo, workspace);
    expect(git(repo, "branch", "--list", workspace.branch)).toBe("");
    expect(await publishBranch(repo, workspace.path, workspace.branch)).toEqual({ ok: true });
    expect(git(repo, "rev-parse", workspace.branch)).toBe(wgit(workspace.path, "rev-parse", "HEAD"));
    writeFileSync(join(workspace.path, "b.txt"), "b\n");
    const sha = await commitAll(workspace.path, "feat: b");
    expect(await publishBranch(repo, workspace.path, workspace.branch)).toEqual({ ok: true });
    expect(git(repo, "rev-parse", workspace.branch)).toBe(sha);
    expect(git(repo, "show", `${workspace.branch}:b.txt`)).toBe("b");
  });

  it("is a note, never a failure, when git refuses: the branch is checked out there, or has moved on without the card's commits", async () => {
    const { repo, dir } = repository("publish-");
    const workspace = workspaceFor(task, repo, dir);
    await ensureClone(repo, workspace);
    writeFileSync(join(workspace.path, "b.txt"), "b\n");
    await commitAll(workspace.path, "feat: b");
    git(repo, "checkout", "-q", "-b", workspace.branch);
    const checkedOut = await publishBranch(repo, workspace.path, workspace.branch);
    expect(checkedOut).toMatchObject({ ok: false, note: expect.stringContaining(workspace.branch) });
    git(repo, "checkout", "-q", "main");
    writeFileSync(join(repo, "c.txt"), "c\n");
    git(repo, "checkout", "-q", workspace.branch);
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "a person's own commit on the same branch");
    git(repo, "checkout", "-q", "main");
    const mine = git(repo, "rev-parse", workspace.branch);
    expect(await publishBranch(repo, workspace.path, workspace.branch)).toMatchObject({ ok: false });
    expect(git(repo, "rev-parse", workspace.branch)).toBe(mine);
  });

  it("refuses a name shaped like an option", async () => {
    const { repo, dir } = repository("publish-");
    const workspace = workspaceFor(task, repo, dir);
    await ensureClone(repo, workspace);
    expect(await publishBranch(repo, workspace.path, "--upload-pack=x")).toMatchObject({ ok: false });
  });
});
