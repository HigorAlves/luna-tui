import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { branchBase, commitAll, ensureWorktree, workspaceFor } from "./worktree.ts";

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
