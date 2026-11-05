import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { commitsSince, dirtyFiles, stagePending, discardPending, findCommitBySubject, branchBase, commitAll, defaultHead, ensureCleanCheckout, graphCheckoutPath, isAncestor, ensurePrWorktree, ensureWorktree, intakeCheckoutPath, ownedWorkspace, prWorktreePath, workspaceFor } from "./worktree.ts";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], {
    encoding: "utf8",
  }).trim();

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
    await ensureWorktree(repo, workspace);
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
    await ensureWorktree(repo, workspace);
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
    await ensureWorktree(repo, workspace);
    expect(git(workspace.path, "rev-parse", "HEAD")).toBe(tip);
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

  it("recreates a worktree whose directory went missing, instead of failing on the stale registration", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "prune-")));
    const repo = join(root, "repo");
    mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "a.txt"), "a\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "init");
    const workspace = workspaceFor({ id: "11111111-2222-3333-4444-555555555555", title: "Fix it" } as never, repo, join(root, "wt"));
    await ensureWorktree(repo, workspace);
    rmSync(workspace.path, { recursive: true, force: true });

    await ensureWorktree(repo, workspace);
    expect(existsSync(join(workspace.path, "a.txt"))).toBe(true);
    expect(git(workspace.path, "branch", "--show-current")).toBe(workspace.branch);
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
    await ensureWorktree(repo, workspace);
    const lock = join(git(workspace.path, "rev-parse", "--git-dir"), "index.lock");
    writeFileSync(lock, "");
    const old = new Date(Date.now() - 10 * 60_000);
    utimesSync(lock, old, old);

    await ensureWorktree(repo, workspace);
    expect(existsSync(lock)).toBe(false);
    writeFileSync(join(workspace.path, "b.txt"), "b\n");
    expect(await commitAll(workspace.path, "feat: b")).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("a PR task's worktree", () => {
  it("checks the PR's head branch out from origin, and a second call only reuses it", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "pr-wt-")));
    const upstream = join(root, "upstream");
    mkdirSync(upstream);
    git(upstream, "init", "-q", "-b", "main");
    writeFileSync(join(upstream, "a.txt"), "a\n");
    git(upstream, "add", "-A");
    git(upstream, "commit", "-q", "-m", "init");
    git(upstream, "switch", "-q", "-c", "feat/export");
    writeFileSync(join(upstream, "b.txt"), "b\n");
    git(upstream, "add", "-A");
    git(upstream, "commit", "-q", "-m", "feat: export");
    const tip = git(upstream, "rev-parse", "HEAD");
    git(upstream, "switch", "-q", "main");
    const repo = join(root, "repo");
    git(root, "clone", "-q", upstream, repo);

    const path = prWorktreePath(repo, join(root, "wt"), 12, "feat/export");
    expect(path).toBe(join(root, "wt", "repo", "pr-12-feat-export"));
    await ensurePrWorktree(repo, "feat/export", path);
    expect(git(path, "rev-parse", "HEAD")).toBe(tip);
    expect(git(path, "branch", "--show-current")).toBe("feat/export");
    expect(git(path, "rev-parse", "--abbrev-ref", "@{u}")).toBe("origin/feat/export");
    await ensurePrWorktree(repo, "feat/export", path);
    expect(existsSync(join(path, "b.txt"))).toBe(true);
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
    const root = realpathSync(mkdtempSync(join(tmpdir(), "tests-step-")));
    git(root, "init", "-q", "-b", "main");
    writeFileSync(join(root, "a.txt"), "a\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "init");
    return root;
  };

  it("stages what the writer left, new files included, and reads it as a name-status and a diff", async () => {
    const root = repoWith();
    writeFileSync(join(root, "cart.test.ts"), "it('x @scenario:S1', () => {})\n");
    const pending = await stagePending(root);
    expect(pending.nameStatus).toBe("A\tcart.test.ts");
    expect(pending.diff).toContain("+it('x @scenario:S1'");
  });

  it("discards everything the writer left: edits and new files", async () => {
    const root = repoWith();
    writeFileSync(join(root, "a.txt"), "changed\n");
    writeFileSync(join(root, "new.test.ts"), "x\n");
    await stagePending(root);
    await discardPending(root);
    expect(await dirtyFiles(root)).toEqual([]);
    expect(existsSync(join(root, "new.test.ts"))).toBe(false);
  });

  it("finds the commit with a subject, with what it changed, and null when there is none", async () => {
    const root = repoWith();
    expect(await findCommitBySubject(root, "test(abc): scenarios")).toBeNull();
    writeFileSync(join(root, "cart.test.ts"), "t\n");
    const sha = await commitAll(root, "test(abc): scenarios\n\nplan version 2");
    const found = await findCommitBySubject(root, "test(abc): scenarios");
    expect(found).toMatchObject({ sha, nameStatus: "A\tcart.test.ts" });
    expect(found!.diff).toContain("+t");
  });
});

describe("commitsSince", () => {
  it("lists the commits made after a time with each file's name and added and removed counts, and no content", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "since-")));
    git(root, "init", "-q", "-b", "main");
    writeFileSync(join(root, "a.txt"), "one\n");
    git(root, "add", "-A");
    execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "old", "--date=2020-01-01T00:00:00Z"], { env: { ...process.env, GIT_COMMITTER_DATE: "2020-01-01T00:00:00Z" } });
    writeFileSync(join(root, "a.txt"), "one\ntwo\nthree\n");
    writeFileSync(join(root, "b.txt"), "secret content\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "fix: the person's change");
    const commits = await commitsSince(root, "2024-01-01T00:00:00Z");
    expect(commits).toEqual([{ sha: expect.stringMatching(/^[0-9a-f]{40}$/), files: expect.arrayContaining([{ path: "a.txt", added: 2, removed: 0 }, { path: "b.txt", added: 1, removed: 0 }]) }]);
    expect(JSON.stringify(commits)).not.toContain("secret content");
    expect(await commitsSince(root, new Date(Date.now() + 86_400_000).toISOString())).toEqual([]);
  });
});
