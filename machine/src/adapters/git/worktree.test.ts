import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ensureClone } from "./clone.ts";
import { machineGitDir } from "./machine-repo.ts";
import { changedSince, commitsSince, currentBranch, dirtyFiles, headCommit, stagePending, readCommitDiff, branchBase, commitAll, defaultHead, checkoutHead, ensureCleanCheckout, graphCheckoutPath, isAncestor,  intakeCheckoutPath, ownedWorkspace, prWorktreePath, workspaceFor } from "./worktree.ts";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], {
    encoding: "utf8",
  }).trim();

/** git on a card's workspace, the way the host runs it: the machine's repository as the git directory, the folder as the work tree. */
const wgit = (path: string, ...args: string[]) =>
  execFileSync("git", ["--git-dir=" + machineGitDir(path), "--work-tree=" + path, "-C", path, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).trim();


/** A work folder with a repository of the machine's, one commit on `main` (a.txt), nothing in it of its own. */
function workspaceWith(prefix: string, content = "a\n"): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", machineGitDir(root)]);
  writeFileSync(join(root, "a.txt"), content);
  wgit(root, "add", "-A");
  wgit(root, "commit", "-q", "-m", "init");
  return root;
}

describe("host-side git", () => {
  it("never runs the repo's hooks: a hook a stage planted cannot execute as you", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "hooks-")));
    const repo = join(root, "repo");
    mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "a.txt"), "a\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "init");
    // What a compromised writable stage could leave behind in the shared .git dir.
    const marker = join(root, "hook-ran");
    mkdirSync(join(repo, ".git", "hooks"), { recursive: true });
    writeFileSync(join(repo, ".git", "hooks", "pre-commit"), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });

    const workspace = workspaceFor({ id: "11111111-2222-3333-4444-555555555555", title: "Fix it" } as never, repo, join(root, "wt"));
    await ensureClone(repo, workspace);
    writeFileSync(join(workspace.path, "b.txt"), "b\n");
    const sha = await commitAll(workspace.path, "feat: b");

    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(existsSync(marker)).toBe(false);
  });

  it("knows where the task branch forked from the repo, even after the repo moves on", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "base-")));
    const repo = join(root, "repo");
    mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "a.txt"), "a\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "init");
    const fork = git(repo, "rev-parse", "HEAD");

    const workspace = workspaceFor({ id: "11111111-2222-3333-4444-555555555555", title: "Fix it" } as never, repo, join(root, "wt"));
    await ensureClone(repo, workspace);
    writeFileSync(join(workspace.path, "b.txt"), "b\n");
    await commitAll(workspace.path, "feat: b");
    writeFileSync(join(repo, "c.txt"), "c\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "main moved on");

    expect(await branchBase(workspace.path, repo)).toBe(fork);
    expect(await branchBase(join(root, "nowhere"), repo)).toBeNull();
  });

  it("starts a task branch from origin's default branch when the local checkout is behind it", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "origin-")));
    const upstream = join(root, "upstream");
    mkdirSync(upstream);
    git(upstream, "init", "-q", "-b", "main");
    writeFileSync(join(upstream, "a.txt"), "a\n");
    git(upstream, "add", "-A");
    git(upstream, "commit", "-q", "-m", "init");
    const repo = join(root, "repo");
    git(root, "clone", "-q", upstream, repo);
    // The upstream moves on; the local checkout does not pull.
    writeFileSync(join(upstream, "b.txt"), "b\n");
    git(upstream, "add", "-A");
    git(upstream, "commit", "-q", "-m", "upstream moved on");
    const tip = git(upstream, "rev-parse", "HEAD");

    const workspace = workspaceFor({ id: "11111111-2222-3333-4444-555555555555", title: "Fix it" } as never, repo, join(root, "wt"));
    await ensureClone(repo, workspace);
    expect(wgit(workspace.path, "rev-parse", "HEAD")).toBe(tip);
    expect(git(repo, "rev-parse", "HEAD")).not.toBe(tip);
  });

  it("keeps a clean detached checkout of origin's default branch for intake, reset to the tip on every call", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "intake-")));
    const upstream = join(root, "upstream");
    mkdirSync(upstream);
    git(upstream, "init", "-q", "-b", "main");
    writeFileSync(join(upstream, "a.txt"), "a\n");
    git(upstream, "add", "-A");
    git(upstream, "commit", "-q", "-m", "init");
    const repo = join(root, "repo");
    git(root, "clone", "-q", upstream, repo);
    // Your live checkout is dirty and behind; neither must show in what the pack reads.
    writeFileSync(join(repo, "secret.env"), "TOKEN=x\n");
    writeFileSync(join(upstream, "b.txt"), "b\n");
    git(upstream, "add", "-A");
    git(upstream, "commit", "-q", "-m", "upstream moved on");
    const tip = git(upstream, "rev-parse", "HEAD");

    const path = intakeCheckoutPath(repo, join(root, "wt"));
    expect(path).toBe(join(root, "wt", "repo", "jira-intake"));
    expect(await ensureCleanCheckout(repo, path)).toBe(path);
    expect(git(path, "rev-parse", "HEAD")).toBe(tip);
    expect(git(path, "branch", "--show-current")).toBe("");
    expect(existsSync(join(path, "secret.env"))).toBe(false);
    expect(existsSync(join(path, "b.txt"))).toBe(true);

    // A later run: whatever was left there goes, and the upstream's new tip is checked out.
    writeFileSync(join(path, "left-over.txt"), "x\n");
    writeFileSync(join(path, "a.txt"), "edited\n");
    writeFileSync(join(upstream, "c.txt"), "c\n");
    git(upstream, "add", "-A");
    git(upstream, "commit", "-q", "-m", "and again");
    await ensureCleanCheckout(repo, path);
    expect(git(path, "rev-parse", "HEAD")).toBe(git(upstream, "rev-parse", "HEAD"));
    expect(existsSync(join(path, "left-over.txt"))).toBe(false);
    expect(existsSync(join(path, "c.txt"))).toBe(true);
    expect(git(repo, "rev-parse", "HEAD")).not.toBe(tip);
  });

  it("reads HEAD of a read-only checkout the machine made, from the repository that registered it, and refuses a link or an unregistered folder", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "checkout-head-")));
    const repo = join(root, "repo");
    mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "a.txt"), "a\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "init");
    const path = graphCheckoutPath("repo", join(root, "wt"));
    await ensureCleanCheckout(repo, path);
    // A card's headCommit has no machine repository for this folder; the checkout reader does not need one.
    await expect(headCommit(path)).rejects.toThrow();
    expect(await checkoutHead(repo, path)).toBe(git(repo, "rev-parse", "HEAD"));

    // The folder's own `.git` file is never read: one pointing at another repository changes nothing.
    const other = join(root, "other");
    mkdirSync(other);
    git(other, "init", "-q", "-b", "main");
    writeFileSync(join(other, "x.txt"), "x\n");
    git(other, "add", "-A");
    git(other, "commit", "-q", "-m", "other");
    writeFileSync(join(path, ".git"), `gitdir: ${join(other, ".git")}\n`);
    expect(await checkoutHead(repo, path)).toBe(git(repo, "rev-parse", "HEAD"));

    // A link in place of the checkout, and a folder the repository did not register, are refused.
    const link = join(root, "link");
    symlinkSync(path, link);
    await expect(checkoutHead(repo, link)).rejects.toThrow(/not a checkout/);
    await expect(checkoutHead(repo, join(root, "wt"))).rejects.toThrow(/not a checkout the repository registered/);
    await expect(checkoutHead(repo, other)).rejects.toThrow(/not a checkout the repository registered/);
  });

  it("recreates a worktree whose directory went missing, instead of failing on the stale registration", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "prune-")));
    const repo = join(root, "repo");
    mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "a.txt"), "a\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "init");
    const workspace = workspaceFor({ id: "11111111-2222-3333-4444-555555555555", title: "Fix it" } as never, repo, join(root, "wt"));
    await ensureClone(repo, workspace);
    rmSync(workspace.path, { recursive: true, force: true });

    await ensureClone(repo, workspace);
    expect(existsSync(join(workspace.path, "a.txt"))).toBe(true);
    expect(wgit(workspace.path, "branch", "--show-current")).toBe(workspace.branch);
  });

  it("clears a stale index.lock left by a killed git, so the next attempt can commit", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "lock-")));
    const repo = join(root, "repo");
    mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "a.txt"), "a\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "init");
    const workspace = workspaceFor({ id: "11111111-2222-3333-4444-555555555555", title: "Fix it" } as never, repo, join(root, "wt"));
    await ensureClone(repo, workspace);
    const lock = join(wgit(workspace.path, "rev-parse", "--git-dir"), "index.lock");
    writeFileSync(lock, "");
    const old = new Date(Date.now() - 10 * 60_000);
    utimesSync(lock, old, old);

    await ensureClone(repo, workspace);
    expect(existsSync(lock)).toBe(false);
    writeFileSync(join(workspace.path, "b.txt"), "b\n");
    expect(await commitAll(workspace.path, "feat: b")).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("workspaceFor", () => {
  const task = { id: "a1b2c3d4-0000-0000-0000-000000000000", title: "Login page!", route: "feature" };
  const link = { key: "PLAT-123", url: "u", issueType: "Bug", status: null, priority: null, dueAt: null, syncedAt: null, blocked: null };

  it("names task/<id8>-<slug> for an unlinked task and the repo's jira.branch pattern for a linked one, the folder being the branch with / as -", () => {
    expect(workspaceFor(task, "/repos/app", "/wt")).toEqual({ branch: "task/a1b2c3d4-login-page", path: "/wt/app/task-a1b2c3d4-login-page" });
    expect(workspaceFor({ ...task, jira: link }, "/repos/app", "/wt")).toEqual({ branch: "bug/PLAT-123", path: "/wt/app/bug-PLAT-123" });
    expect(workspaceFor({ ...task, jira: { ...link, issueType: "Tech Debt" } }, "/repos/app", "/wt").branch).toBe("tech-debt/PLAT-123");
    expect(workspaceFor({ ...task, jira: { ...link, issueType: null } }, "/repos/app", "/wt").branch).toBe("task/PLAT-123");
    expect(workspaceFor({ ...task, jira: link }, "/repos/app", "/wt", "task/{key}-{slug}-{route}-{id}").branch).toBe("task/PLAT-123-login-page-feature-a1b2c3d4");
    // An intake import links through its source before JiraWatch fills the column.
    expect(workspaceFor({ ...task, source: { kind: "jira", key: "PLAT-9", url: "u", issueType: "Story" } }, "/repos/app", "/wt").branch).toBe("story/PLAT-9");
  });

  it("names a notch task's branch from its jiraKey through the pattern, and task/<id8>-<slug> without one", () => {
    const notch = (jiraKey?: string | null) => ({ ...task, source: { kind: "notch" as const, ref: "LUNA-14", id: "n-1", jiraKey } });
    expect(workspaceFor(notch("PLAT-123"), "/repos/app", "/wt")).toEqual({ branch: "task/PLAT-123", path: "/wt/app/task-PLAT-123" });
    expect(workspaceFor(notch("PLAT-123"), "/repos/app", "/wt", "feat/{key}-{slug}").branch).toBe("feat/PLAT-123-login-page");
    expect(workspaceFor(notch(null), "/repos/app", "/wt").branch).toBe("task/a1b2c3d4-login-page");
    expect(workspaceFor(notch(), "/repos/app", "/wt").branch).toBe("task/a1b2c3d4-login-page");
  });

  it("appends the task id when the repo already has the branch the pattern names (and the pattern has no {id} or {slug})", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "owned-")));
    const repo = join(root, "repo");
    mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "a.txt"), "a\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "init");
    const linked = { ...task, jira: link };
    expect((await ownedWorkspace(linked, repo, join(root, "wt"))).branch).toBe("bug/PLAT-123");
    // An older task (or a person) left a bug/PLAT-123 behind: this task gets its own.
    git(repo, "branch", "bug/PLAT-123");
    expect(await ownedWorkspace(linked, repo, join(root, "wt"))).toEqual({ branch: "bug/PLAT-123-a1b2c3d4", path: join(root, "wt", "repo", "bug-PLAT-123-a1b2c3d4") });
    expect((await ownedWorkspace(linked, repo, join(root, "wt"), "{type}/{key}-{slug}")).branch).toBe("bug/PLAT-123-login-page");
    git(repo, "branch", "task/a1b2c3d4-login-page");
    expect((await ownedWorkspace(task, repo, join(root, "wt"))).branch).toBe("task/a1b2c3d4-login-page");
  });
});

describe("graph helpers", () => {
  it("names the graph checkout beside the intake one", () => {
    // Keyed by the graph store's slug, never the basename: two repos named api must not share a checkout.
    expect(graphCheckoutPath("api-0123abcd", "/wt")).toBe("/wt/api-0123abcd/graph");
    expect(graphCheckoutPath("api-89efcdef", "/wt")).not.toBe(graphCheckoutPath("api-0123abcd", "/wt"));
  });

  it("answers the default branch's head and ancestry", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "graph-git-")));
    git(root, "init", "-q", "-b", "main");
    writeFileSync(join(root, "a.txt"), "a\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "one");
    const one = git(root, "rev-parse", "HEAD");
    writeFileSync(join(root, "b.txt"), "b\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "two");
    const two = git(root, "rev-parse", "HEAD");
    expect(await defaultHead(root)).toBe(two);
    expect(await isAncestor(root, one, two)).toBe(true);
    expect(await isAncestor(root, two, one)).toBe(false);
    expect(await isAncestor(root, "c".repeat(40), two)).toBe(false);
  });
});

describe("the tests step's git", () => {
  const repoWith = () => {
    const root = workspaceWith("tests-step-", "a\n");
    return { root, base: wgit(root, "rev-parse", "HEAD") };
  };

  it("stages what the writer left, new files included, and reads it against the base as a name-status, a diff and each path's new mode", async () => {
    const { root, base } = repoWith();
    writeFileSync(join(root, "cart.test.ts"), "it('x @scenario:S1', () => {})\n");
    const pending = await stagePending(root, base);
    expect(pending.nameStatus).toBe("A\tcart.test.ts");
    expect(pending.diff).toContain("+it('x @scenario:S1'");
    expect(pending.modes).toEqual({ "cart.test.ts": "100644" });
  });

  it("reports a symlink as mode 120000, and refuses a nested repository (a gitlink, mode 160000) instead of staging it", async () => {
    const root = workspaceWith("tests-step-");
    const base = wgit(root, "rev-parse", "HEAD");
    mkdirSync(join(root, "tests"));
    symlinkSync("../a.txt", join(root, "tests", "link.test.ts"));
    const pending = await stagePending(root, base);
    expect(pending.modes?.["tests/link.test.ts"]).toBe("120000");
    mkdirSync(join(root, "tests", "vendor"));
    git(join(root, "tests", "vendor"), "init", "-q", "-b", "main");
    writeFileSync(join(root, "tests", "vendor", "f"), "x");
    await expect(stagePending(root, base)).rejects.toThrow(/nested repository/);
  });

  it("reads against the base even when the container committed in between", async () => {
    const { root, base } = repoWith();
    writeFileSync(join(root, "src.ts"), "production\n");
    wgit(root, "add", "-A");
    wgit(root, "commit", "-q", "-m", "test(abc): scenarios");
    const pending = await stagePending(root, base);
    expect(pending.nameStatus).toBe("A\tsrc.ts");
  });

  it("reads what one commit changed, only when it is an ancestor of HEAD", async () => {
    const { root } = repoWith();
    writeFileSync(join(root, "cart.test.ts"), "t\n");
    const sha = await commitAll(root, "test(abc): scenarios\n\nplan version 2");
    const read = await readCommitDiff(root, sha!);
    expect(read).toMatchObject({ nameStatus: "A\tcart.test.ts", modes: { "cart.test.ts": "100644" }, parent: wgit(root, "rev-parse", "HEAD~1") });
    expect(read!.diff).toContain("+t");
    wgit(root, "checkout", "-q", "-b", "other", "HEAD~1");
    expect(await readCommitDiff(root, sha!)).toBeNull();
    expect(await readCommitDiff(root, "nonsense")).toBeNull();
  });
});

describe("commitsSince", () => {
  const repo = () => {
    const root = workspaceWith("since-", "one\n");
    return { root, from: wgit(root, "rev-parse", "HEAD") };
  };

  it("lists the commits made after a sha with each file's name and added and removed counts, and no content", async () => {
    const { root, from } = repo();
    writeFileSync(join(root, "a.txt"), "one\ntwo\nthree\n");
    writeFileSync(join(root, "b.txt"), "secret content\n");
    wgit(root, "add", "-A");
    wgit(root, "commit", "-q", "-m", "fix: the person's change");
    const commits = await commitsSince(root, from);
    expect(commits).toEqual([{ sha: expect.stringMatching(/^[0-9a-f]{40}$/), files: expect.arrayContaining([{ path: "a.txt", added: 2, removed: 0 }, { path: "b.txt", added: 1, removed: 0 }]) }]);
    expect(JSON.stringify(commits)).not.toContain("secret content");
    expect(await commitsSince(root, wgit(root, "rev-parse", "HEAD"))).toEqual([]);
  });

  it("does not select by committer date, which the agent can set: a commit dated in the past is listed, one dated in the future too, by the sha range alone", async () => {
    const { root, from } = repo();
    writeFileSync(join(root, "b.txt"), "x\n");
    wgit(root, "add", "-A");
    execFileSync("git", ["--git-dir=" + machineGitDir(root), "--work-tree=" + root, "-C", root, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "back-dated", "--date=2001-01-01T00:00:00Z"], { env: { ...process.env, GIT_COMMITTER_DATE: "2001-01-01T00:00:00Z" } });
    expect((await commitsSince(root, from)).length).toBe(1);
  });

  it("refuses a `since` that is not a sha, and keeps its answer small: 100 commits, 200 files a commit, 300 characters of path", async () => {
    const { root, from } = repo();
    expect(await commitsSince(root, "--all")).toEqual([]);
    expect(await commitsSince(root, "2024-01-01")).toEqual([]);
    for (let i = 0; i < 3; i++) {
      for (let f = 0; f < 205; f++) writeFileSync(join(root, `f${i}-${f}.txt`), "x\n");
      wgit(root, "add", "-A");
      wgit(root, "commit", "-q", "-m", `c${i}`);
    }
    const commits = await commitsSince(root, from);
    expect(commits).toHaveLength(3);
    expect(commits[0]!.files).toHaveLength(200);
    mkdirSync(join(root, "d".repeat(150)), { recursive: true });
    writeFileSync(join(root, "d".repeat(150), "e".repeat(200)), "x\n");
    wgit(root, "add", "-A");
    wgit(root, "commit", "-q", "-m", "long");
    expect((await commitsSince(root, from))[0]!.files[0]!.path.length).toBeLessThanOrEqual(300);
  });
});

describe("currentBranch", () => {
  it("names the branch the worktree is on", async () => {
    const root = workspaceWith("branch-");
    expect(await currentBranch(root)).toBe("main");
    wgit(root, "checkout", "-q", "-b", "task/x");
    expect(await currentBranch(root)).toBe("task/x");
  });
});

describe("git that takes a path, near the workspaces", () => {
  it("clearStaleLock removes an old lock in the card's repository, and in a read-only checkout, without running git", async () => {
    const { clearStaleLock } = await import("./worktree.ts");
    const root = workspaceWith("lock-");
    const lock = join(machineGitDir(root), "index.lock");
    writeFileSync(lock, "");
    utimesSync(lock, new Date(Date.now() - 120_000), new Date(Date.now() - 120_000));
    await clearStaleLock(root);
    expect(existsSync(lock)).toBe(false);
    // A hostile .git in the folder is not consulted: the lock is looked for in the card's repository only.
    mkdirSync(join(root, ".git"), { recursive: true });
    writeFileSync(join(root, ".git", "config"), "[core]\n\tfsmonitor = touch /nonexistent-marker\n");
    await expect(clearStaleLock(root)).resolves.toBeUndefined();
  });

  it("originSlugOf answers from the card's repository, and fails closed for a folder under the workspaces directory that has none", async () => {
    const { originSlugOf } = await import("./worktree.ts");
    const { configureWorkspacesDir } = await import("./machine-repo.ts");
    const root = workspaceWith("slug-");
    wgit(root, "remote", "add", "origin", "https://github.com/acme/widgets.git");
    expect(await originSlugOf(root)).toBe("acme/widgets");
    const stray = realpathSync(mkdtempSync(join(tmpdir(), "stray-")));
    git(stray, "init", "-q");
    git(stray, "remote", "add", "origin", "https://github.com/acme/other.git");
    expect(await originSlugOf(stray)).toBe("acme/other");
    configureWorkspacesDir(join(stray, ".."));
    try {
      expect(await originSlugOf(stray)).toBeNull();
    } finally {
      configureWorkspacesDir("/nonexistent-workspaces-dir");
    }
  });
});

describe("changedSince: the files a delta check is scoped to", () => {
  const exec = (stdout: string, code = 0) => async () => ({ code, stdout, stderr: "" });
  const SHA = "a".repeat(40);

  it("lists the files changed since a commit", async () => {
    expect(await changedSince(exec("src/a.ts\n\nsrc/b.ts\n"), "/wt", SHA)).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("an empty delta is unknown, so every check runs: nothing is not a reason to run nothing", async () => {
    expect(await changedSince(exec(""), "/wt", SHA)).toBeNull();
    expect(await changedSince(exec("\n"), "/wt", SHA)).toBeNull();
  });

  it("a failed diff or a ref that is not a commit id is unknown too", async () => {
    expect(await changedSince(exec("src/a.ts", 1), "/wt", SHA)).toBeNull();
    expect(await changedSince(exec("src/a.ts"), "/wt", "main; rm -rf")).toBeNull();
  });
});
