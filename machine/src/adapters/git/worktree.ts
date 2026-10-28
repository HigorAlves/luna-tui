// Task worktrees on the host. Each task gets its own branch and checkout; the agent works
// there through a bind mount, and the machine commits on the host.
import { existsSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";

import { jiraBranch, jiraOf, slug } from "../../domain/jira-link.ts";
import { DEFAULT_JIRA_BRANCH } from "../../domain/policy.ts";
import { exec, execOrThrow } from "../process/exec.ts";

export { slug };

/** Every git command the machine runs on the host carries this: a stage can write into
 *  the shared .git dir, and a hook it left there must never execute as you. */
export const HOST_GIT = ["-c", "core.hooksPath=/dev/null"] as const;

export interface Workspace {
  branch: string;
  path: string;
}

/** Branch and checkout path for a task, following herdr's `<dir>/<repo>/<branch>` layout. A
 *  Jira-linked task takes the repo's `jira.branch` pattern (`{type}/{key}` by default, so
 *  `bug/PLAT-123`); every other task `task/<id8>-<slug>`. The checkout folder is the branch
 *  with `/` as `-`, so `bug/PLAT-123` lives in `<repo>/bug-PLAT-123`. */
export function workspaceFor(
  task: { id: string; title: string; route?: string; jira?: import("@hardness/contracts").JiraLink | null; source?: import("@hardness/contracts").TaskSource | null },
  repoPath: string,
  worktreesDir: string,
  jiraPattern?: string,
): Workspace {
  const linked = jiraBranch({ id: task.id, title: task.title, route: task.route ?? "feature", jira: task.jira ?? null, source: task.source ?? null }, jiraPattern);
  const branch = linked ?? `task/${task.id.slice(0, 8)}-${slug(task.title)}`;
  return { branch, path: join(worktreesDir, basename(repoPath), branch.replaceAll("/", "-")) };
}

/**
 * The workspace the pipeline owns for a task that has none yet: `workspaceFor`, except that a
 * linked task whose pattern names a branch the repo already has (an older task on the same
 * issue, or a person's) gets the task id appended, so no two tasks ever share a branch. A
 * pattern with `{id}` or `{slug}` already tells tasks apart and is left alone.
 */
export async function ownedWorkspace(task: Parameters<typeof workspaceFor>[0], repoPath: string, worktreesDir: string, jiraPattern: string = DEFAULT_JIRA_BRANCH): Promise<Workspace> {
  const plain = workspaceFor(task, repoPath, worktreesDir, jiraPattern);
  const linked = jiraOf({ jira: task.jira ?? null, source: task.source ?? null }) !== null;
  if (!linked || jiraPattern.includes("{id}") || jiraPattern.includes("{slug}")) return plain;
  if (!(await branchExists(repoPath, plain.branch))) return plain;
  return workspaceFor(task, repoPath, worktreesDir, `${jiraPattern}-{id}`);
}

/** Whether `refs/heads/<branch>` exists in the repo. */
export async function branchExists(repoPath: string, branch: string): Promise<boolean> {
  return (await exec("git", [...HOST_GIT, "-C", repoPath, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`])).code === 0;
}

/** A lock older than this was left by a git that died, not one that is running. */
const STALE_LOCK_MS = 60_000;
const FETCH_TIMEOUT_MS = 60_000;

/**
 * Creates the worktree on a new branch, unless it already exists. The branch starts from
 * origin's default branch after a fetch (your checkout may be days behind it); with no
 * origin, from the repo's HEAD. A registration whose directory went missing is pruned first,
 * and an index.lock a killed git left in an existing worktree is cleared.
 */
export async function ensureWorktree(repoPath: string, workspace: Workspace): Promise<void> {
  if (existsSync(join(workspace.path, ".git"))) {
    await clearStaleLock(workspace.path);
    return;
  }
  await exec("git", [...HOST_GIT, "-C", repoPath, "worktree", "prune"]);
  const branchExists =
    (await exec("git", [...HOST_GIT, "-C", repoPath, "rev-parse", "--verify", "--quiet", workspace.branch]))
      .code === 0;
  const args = branchExists
    ? ["worktree", "add", workspace.path, workspace.branch]
    : ["worktree", "add", "-b", workspace.branch, workspace.path, await startPoint(repoPath)];
  await execOrThrow("git", [...HOST_GIT, "-C", repoPath, ...args]);
}

/** The read-only checkout the jira_intake pack reads a repo through: `<dir>/<repo>/jira-intake`. */
export const INTAKE_CHECKOUT = "jira-intake";
export function intakeCheckoutPath(repoPath: string, worktreesDir: string): string {
  return join(worktreesDir, basename(repoPath), INTAKE_CHECKOUT);
}

/**
 * A clean, detached checkout of the default branch at `path`, fresh for every run: created from
 * `origin/<default>` after a fetch (the repo's own HEAD without an origin) when missing, else
 * fetched and reset hard to it with untracked files removed. Whatever sits half-edited in the
 * live checkout never reaches a pack that reads through this. Answers `path`.
 */
export async function ensureCleanCheckout(repoPath: string, path: string): Promise<string> {
  const ref = await startPoint(repoPath);
  const sha = await execOrThrow("git", [...HOST_GIT, "-C", repoPath, "rev-parse", ref]);
  if (!existsSync(join(path, ".git"))) {
    await exec("git", [...HOST_GIT, "-C", repoPath, "worktree", "prune"]);
    await execOrThrow("git", [...HOST_GIT, "-C", repoPath, "worktree", "add", "--detach", path, sha]);
    return path;
  }
  await clearStaleLock(path);
  await resetWorktree(path, sha);
  return path;
}

/** `origin/<default>` freshly fetched when the repo has an origin; HEAD otherwise. */
async function startPoint(repoPath: string): Promise<string> {
  const head = await exec("git", [...HOST_GIT, "-C", repoPath, "symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
  if (head.code !== 0) return "HEAD";
  const ref = head.stdout.trim().replace(/^refs\/remotes\//, "");
  const fetched = await exec("git", [...HOST_GIT, "-C", repoPath, "fetch", "--quiet", "origin"], { timeoutMs: FETCH_TIMEOUT_MS });
  if (fetched.code !== 0) console.warn(`git fetch origin failed in ${repoPath}; basing on the last fetched ${ref}`);
  return ref;
}

async function clearStaleLock(worktreePath: string): Promise<void> {
  const gitDir = await exec("git", [...HOST_GIT, "-C", worktreePath, "rev-parse", "--git-dir"]);
  if (gitDir.code !== 0) return;
  const dir = gitDir.stdout.trim();
  const lock = join(dir.startsWith("/") ? dir : join(worktreePath, dir), "index.lock");
  try {
    if (Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS) rmSync(lock, { force: true });
  } catch {
    // no lock, or gone already
  }
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

/** The commit the task branch forked from: the merge base of the worktree's HEAD and the
 *  repo's own HEAD (which may have moved on since). Null when either side is not a repo. */
export async function branchBase(worktreePath: string, repoPath: string): Promise<string | null> {
  const repoHead = await exec("git", [...HOST_GIT, "-C", repoPath, "rev-parse", "HEAD"]);
  if (repoHead.code !== 0) return null;
  const base = await exec("git", [...HOST_GIT, "-C", worktreePath, "merge-base", "HEAD", repoHead.stdout.trim()]);
  return base.code === 0 ? base.stdout.trim() || null : null;
}

/** The files the branch changed since it forked from the repo, worktree-relative; null when
 *  the base is unknown, so a caller runs every check rather than none. */
export async function changedPaths(worktreePath: string, repoPath: string): Promise<string[] | null> {
  const base = await branchBase(worktreePath, repoPath);
  if (!base) return null;
  const out = await exec("git", [...HOST_GIT, "-C", worktreePath, "diff", "--name-only", `${base}..HEAD`]);
  if (out.code !== 0) return null;
  return out.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
}

/** Lines added and removed on the branch since `base`, from `git diff --shortstat`. */
export async function diffShortstat(path: string, base: string): Promise<{ added: number; removed: number }> {
  const out = await execOrThrow("git", [...HOST_GIT, "-C", path, "diff", "--shortstat", `${base}..HEAD`]);
  const added = Number(/(\d+) insertion/.exec(out)?.[1] ?? 0);
  const removed = Number(/(\d+) deletion/.exec(out)?.[1] ?? 0);
  return { added, removed };
}

/** The branch's diff against the repo's current HEAD base; null when the base is unknown. */
export async function branchDiffStat(worktreePath: string, repoPath: string | null): Promise<{ added: number; removed: number } | null> {
  if (!repoPath) return null;
  const base = await branchBase(worktreePath, repoPath);
  return base ? diffShortstat(worktreePath, base) : null;
}

export function headCommit(path: string): Promise<string> {
  return execOrThrow("git", [...HOST_GIT, "-C", path, "rev-parse", "HEAD"]);
}

/** `git diff --name-status <from> <to>` in `path`, for checking what a commit touched. */
export function diffNameStatus(path: string, from: string, to: string): Promise<string> {
  return execOrThrow("git", [...HOST_GIT, "-C", path, "diff", "--name-status", from, to]);
}

/** Undoes one commit with a new commit on top (never rewrites history a person may have fetched). */
export async function revertCommit(path: string, sha: string): Promise<void> {
  await execOrThrow("git", [...HOST_GIT, "-C", path, "-c", "commit.gpgsign=false", "revert", "--no-edit", sha]);
}

/** Puts `files` back as they are at `ref`, leaving HEAD alone (undo with resetWorktree). */
export async function restoreFiles(path: string, ref: string, files: string[]): Promise<void> {
  await execOrThrow("git", [...HOST_GIT, "-C", path, "checkout", ref, "--", ...files]);
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

/** What the worktree has uncommitted or untracked, one `git status --porcelain` line each. */
export async function dirtyFiles(path: string): Promise<string[]> {
  const status = await execOrThrow("git", [...HOST_GIT, "-C", path, "status", "--porcelain"]);
  return status === "" ? [] : status.split("\n");
}

/** `owner/name` of the checkout's `origin` remote, or null when it has none or it is not on GitHub. */
export async function originSlugOf(cwd: string): Promise<string | null> {
  const url = await exec("git", [...HOST_GIT, "-C", cwd, "remote", "get-url", "origin"]);
  if (url.code !== 0) return null;
  const match = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?\s*$/.exec(url.stdout.trim());
  return match ? `${match[1]}/${match[2]}` : null;
}

/** A PR task's checkout: `<dir>/<repo>/pr-<number>-<head slug>`, beside the task worktrees. */
export function prWorktreePath(repoPath: string, worktreesDir: string, number: number, headRef: string): string {
  return join(worktreesDir, basename(repoPath), `pr-${number}-${slug(headRef)}`);
}

/**
 * Checks a PR's head branch out at `path`, tracking `origin/<headRef>` after a fetch, so a
 * fix lands on the PR's own branch. An existing worktree is reused (its stale lock cleared),
 * not reset: a retry continues from what the last attempt pushed.
 */
export async function ensurePrWorktree(repoPath: string, headRef: string, path: string): Promise<void> {
  if (existsSync(join(path, ".git"))) {
    await clearStaleLock(path);
    return;
  }
  await exec("git", [...HOST_GIT, "-C", repoPath, "worktree", "prune"]);
  const fetched = await exec(
    "git",
    [...HOST_GIT, "-C", repoPath, "fetch", "--quiet", "origin", `+refs/heads/${headRef}:refs/remotes/origin/${headRef}`],
    { timeoutMs: FETCH_TIMEOUT_MS },
  );
  if (fetched.code !== 0) throw new Error(`git fetch origin ${headRef} failed: ${(fetched.stderr || fetched.stdout).trim()}`);
  await execOrThrow("git", [...HOST_GIT, "-C", repoPath, "worktree", "add", "-B", headRef, path, `origin/${headRef}`]);
  await execOrThrow("git", [...HOST_GIT, "-C", path, "branch", "--set-upstream-to", `origin/${headRef}`, headRef]);
}
