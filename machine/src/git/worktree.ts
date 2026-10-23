// Task worktrees on the host. Each task gets its own branch and checkout; the agent works
// there through a bind mount, and the machine commits on the host.
import { existsSync } from "node:fs";
import { basename, join } from "node:path";

import { exec, execOrThrow } from "../sandbox/exec.ts";

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
    (await exec("git", ["-C", repoPath, "rev-parse", "--verify", "--quiet", workspace.branch]))
      .code === 0;
  const args = branchExists
    ? ["worktree", "add", workspace.path, workspace.branch]
    : ["worktree", "add", "-b", workspace.branch, workspace.path, "HEAD"];
  await execOrThrow("git", ["-C", repoPath, ...args]);
}

/** The repo's shared git dir, which the worktree's `.git` file points into. */
export function commonGitDir(repoPath: string): Promise<string> {
  return execOrThrow("git", [
    "-C",
    repoPath,
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
}

export function headCommit(path: string): Promise<string> {
  return execOrThrow("git", ["-C", path, "rev-parse", "HEAD"]);
}

/**
 * Commits everything the agent changed. Returns the new commit, or null when nothing changed.
 * Commits are not signed: signing needs your passphrase, which a background run cannot ask for.
 */
export async function commitAll(path: string, message: string): Promise<string | null> {
  await execOrThrow("git", ["-C", path, "add", "-A"]);
  const staged = await exec("git", ["-C", path, "diff", "--cached", "--quiet"]);
  if (staged.code === 0) return null;
  await execOrThrow("git", ["-C", path, "-c", "commit.gpgsign=false", "commit", "-q", "-m", message]);
  return headCommit(path);
}
