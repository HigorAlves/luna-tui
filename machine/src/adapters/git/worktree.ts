// Task worktrees on the host. Each task gets its own branch and checkout; the agent works
// there through a bind mount, and the machine commits on the host.
import { existsSync } from "node:fs";
import { basename, join } from "node:path";

import { exec, execOrThrow } from "../process/exec.ts";

/** Every git command the machine runs on the host carries this: a stage can write into
 *  the shared .git dir, and a hook it left there must never execute as you. */
export const HOST_GIT = ["-c", "core.hooksPath=/dev/null"] as const;

export interface Workspace {
  branch: string;
  path: string;
}

/** Lowercase ascii words joined by `-`. Never empty. */
export function slug(text: string): string {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return words || "task";
}

/** Branch and checkout path for a task, following herdr's `<dir>/<repo>/<branch>` layout. */
export function workspaceFor(
  task: { id: string; title: string },
  repoPath: string,
  worktreesDir: string,
): Workspace {
  const name = `${task.id.slice(0, 8)}-${slug(task.title)}`;
  return {
    branch: `task/${name}`,
    path: join(worktreesDir, basename(repoPath), `task-${name}`),
  };
}

/** Creates the worktree on a new branch from the repo's HEAD, unless it already exists. */
export async function ensureWorktree(repoPath: string, workspace: Workspace): Promise<void> {
  if (existsSync(join(workspace.path, ".git"))) return;
  const branchExists =
    (await exec("git", [...HOST_GIT, "-C", repoPath, "rev-parse", "--verify", "--quiet", workspace.branch]))
      .code === 0;
  const args = branchExists
    ? ["worktree", "add", workspace.path, workspace.branch]
    : ["worktree", "add", "-b", workspace.branch, workspace.path, "HEAD"];
  await execOrThrow("git", [...HOST_GIT, "-C", repoPath, ...args]);
}

/**
 * Discards whatever a run left uncommitted, back to `ref` (defaults to the current HEAD).
 * Used before a retry, so an aborted, timed out or crashed attempt never hands the next one
 * a half-edited worktree with no explanation — and, with an explicit `ref`, to undo a commit
 * that should never have landed (e.g. one that touched a locked test file).
 */
export async function resetWorktree(path: string, ref = "HEAD"): Promise<void> {
  await execOrThrow("git", [...HOST_GIT, "-C", path, "reset", "--hard", "--quiet", ref]);
  await execOrThrow("git", [...HOST_GIT, "-C", path, "clean", "-fd", "--quiet"]);
}

/** Removes a task's worktree from disk. The branch (and its commits) stays. */
export async function removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
  await execOrThrow("git", [...HOST_GIT, "-C", repoPath, "worktree", "remove", "--force", worktreePath]);
}

/** `user.name` and `user.email` as git resolves them for `repoPath`, or null if either is unset. */
export async function gitIdentity(repoPath: string): Promise<{ name: string; email: string } | null> {
  const read = async (key: string) => (await exec("git", [...HOST_GIT, "-C", repoPath, "config", key])).stdout.trim();
  const [name, email] = await Promise.all([read("user.name"), read("user.email")]);
  return name && email ? { name, email } : null;
}

/** The repo's shared git dir, which the worktree's `.git` file points into. */
export function commonGitDir(repoPath: string): Promise<string> {
  return execOrThrow("git", [...HOST_GIT, 
    "-C",
    repoPath,
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
}

export function headCommit(path: string): Promise<string> {
  return execOrThrow("git", [...HOST_GIT, "-C", path, "rev-parse", "HEAD"]);
}

/** `git diff --name-status <from> <to>` in `path`, for checking what a commit touched. */
export function diffNameStatus(path: string, from: string, to: string): Promise<string> {
  return execOrThrow("git", [...HOST_GIT, "-C", path, "diff", "--name-status", from, to]);
}

/**
 * Commits everything the agent changed. Returns the new commit, or null when nothing changed.
 * Commits are not signed: signing needs your passphrase, which a background run cannot ask for.
 */
export async function commitAll(path: string, message: string): Promise<string | null> {
  await execOrThrow("git", [...HOST_GIT, "-C", path, "add", "-A"]);
  const staged = await exec("git", [...HOST_GIT, "-C", path, "diff", "--cached", "--quiet"]);
  if (staged.code === 0) return null;
  await execOrThrow("git", [...HOST_GIT, "-C", path, "-c", "commit.gpgsign=false", "commit", "-q", "-m", message]);
  return headCommit(path);
}

/** True when the worktree has uncommitted or untracked changes. */
export async function isDirty(path: string): Promise<boolean> {
  return (await execOrThrow("git", [...HOST_GIT, "-C", path, "status", "--porcelain"])) !== "";
}
