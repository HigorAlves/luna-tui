// A card's workspace is its own clone: nothing in it is shared with the user's repository,
// so nothing a container does there can move one of the repository's branches or touch its
// objects, config or hooks. The machine copies in only the settings a push needs.
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

import { exec, execOrThrow } from "../process/exec.ts";
import { HOST_GIT, type Workspace, branchExists, clearStaleLock, headCommit, isBranchName, startPoint } from "./worktree.ts";

const CLONE_TIMEOUT_MS = 300_000;

/** The settings of the repository's own config a push from the clone needs, and nothing else.
 *  Git lower-cases a key's section and variable (never its subsection), so a key is matched by its parts. */
function isCopied(key: string): boolean {
  const first = key.indexOf(".");
  const last = key.lastIndexOf(".");
  if (first === -1) return false;
  const section = key.slice(0, first);
  const variable = key.slice(last + 1);
  const subsection = last > first ? key.slice(first + 1, last) : null;
  if (section === "remote") return subsection === "origin";
  if (section === "url") return subsection !== null && variable === "insteadof";
  if (section === "credential" || section === "http" || section === "user") return true;
  return section === "core" && variable === "sshcommand";
}

/** The repository's local config entries a clone keeps, as `[key, value]` pairs in file order. */
export async function copiedSettings(repoPath: string): Promise<Array<[string, string]>> {
  const out = await exec("git", [...HOST_GIT, "-C", repoPath, "config", "--local", "-z", "--list"]);
  if (out.code !== 0) return [];
  const pairs: Array<[string, string]> = [];
  for (const entry of out.stdout.split("\0")) {
    if (!entry) continue;
    const nl = entry.indexOf("\n");
    const key = nl === -1 ? entry : entry.slice(0, nl);
    if (isCopied(key)) pairs.push([key, nl === -1 ? "" : entry.slice(nl + 1)]);
  }
  return pairs;
}

/** Whether `path` holds a clone (its own `.git` directory) rather than a linked worktree (a `.git` file). */
export function isClone(path: string): boolean {
  try {
    return statSync(join(path, ".git")).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Creates the card's workspace as an independent clone, unless it exists: no hardlinks, no
 * alternates. The branch starts from origin's default branch after a fetch in the repository
 * (its HEAD with no origin), as `ensureWorktree` did. The clone's `origin` is the repository's
 * own remote, so a push reaches the same remote as before; with no remote it is the repository.
 * An existing workspace is reused and a stale `index.lock` cleared.
 */
export async function ensureClone(repoPath: string, workspace: Workspace): Promise<void> {
  if (existsSync(join(workspace.path, ".git"))) {
    await clearStaleLock(workspace.path);
    return;
  }
  const start = await startPoint(repoPath);
  const sha = await execOrThrow("git", [...HOST_GIT, "-C", repoPath, "rev-parse", "--verify", `${start}^{commit}`]);
  await cloneInto(repoPath, workspace.path, workspace.branch, sha);
}

/** An independent clone of `repoPath` at `path` (nothing shared with it), on `branch` at `sha`, with the settings a push needs. */
async function cloneInto(repoPath: string, path: string, branch: string, sha: string): Promise<void> {
  mkdirSync(dirname(path), { recursive: true });
  const cloned = await exec("git", [...HOST_GIT, "clone", "--quiet", "--no-hardlinks", "--no-checkout", "--origin", "origin", "--", repoPath, path], { timeoutMs: CLONE_TIMEOUT_MS });
  if (cloned.code !== 0) throw new Error(`git clone failed: ${(cloned.stderr || cloned.stdout).trim() || `exit code ${cloned.code}`}`);
  await execOrThrow("git", [...HOST_GIT, "-C", path, "checkout", "--quiet", "-B", branch, sha]);
  // The settings a push needs, taken from the repository; a repository with no remote leaves origin at its path.
  const settings = await copiedSettings(repoPath);
  for (const key of new Set(settings.map(([k]) => k))) await exec("git", [...HOST_GIT, "-C", path, "config", "--local", "--unset-all", key]);
  for (const [key, value] of settings) await execOrThrow("git", [...HOST_GIT, "-C", path, "config", "--local", "--add", key, value]);
}

/**
 * Moves a card's linked worktree to a clone before its next writable run: the same branch at the
 * same commit, uncommitted and untracked work carried over, the worktree removed from the
 * repository, and the repository's local branch deleted only when the clone holds the same head.
 * A workspace that is already a clone (or missing) is left alone.
 */
export async function moveToClone(repoPath: string, workspace: Workspace): Promise<void> {
  const old = workspace.path;
  if (!existsSync(join(old, ".git")) || isClone(old)) return;
  const head = await execOrThrow("git", [...HOST_GIT, "-C", old, "rev-parse", "HEAD"]);
  const staging = `${old}.moving`;
  rmSync(staging, { recursive: true, force: true });
  await cloneInto(repoPath, staging, workspace.branch, head);
  // The work tree as the agent left it: every entry but the git link, symlinks kept as links.
  for (const name of readdirSync(old)) {
    if (name !== ".git") cpSync(join(old, name), join(staging, name), { recursive: true, verbatimSymlinks: true, force: true });
  }
  const keep = await exec("git", [...HOST_GIT, "-C", repoPath, "rev-parse", "--verify", "--quiet", `refs/heads/${workspace.branch}`]);
  await execOrThrow("git", [...HOST_GIT, "-C", repoPath, "worktree", "remove", "--force", old]);
  rmSync(old, { recursive: true, force: true });
  renameSync(staging, old);
  if (keep.code === 0 && keep.stdout.trim() === head && (await branchExists(repoPath, workspace.branch))) {
    await exec("git", [...HOST_GIT, "-C", repoPath, "branch", "-D", "--", workspace.branch]);
  }
}

/** A new clone of the card's clone at exactly `sha`, on `branch`, in a new folder: where Verify and a fix run. Origin is the card's own origin. */
export async function freshClone(cardClone: string, sha: string, branch: string, path: string): Promise<void> {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`not a commit id: ${JSON.stringify(sha)}`);
  if (!isBranchName(branch)) throw new Error(`not a usable branch name: ${JSON.stringify(branch)}`);
  if (existsSync(path)) throw new Error(`${path} exists already`);
  await cloneInto(cardClone, path, branch, sha);
}

/**
 * Brings the commits made in a fresh clone back into the card's clone, only as a fast-forward of
 * the card's branch from `from` (the commit the fresh clone was made at): the card's branch must
 * still be at `from` and the fresh clone's branch must descend from it. Anything else is refused
 * and nothing in the card's clone changes. Fetches by a ref the machine names, never by a name the fresh clone gives.
 */
export async function bringBack(cardClone: string, fresh: string, branch: string, from: string): Promise<{ ok: true; head: string } | { ok: false; reason: string }> {
  if (!/^[0-9a-f]{40}$/.test(from) || !isBranchName(branch)) return { ok: false, reason: "not a commit id or a branch name" };
  const head = await exec("git", [...HOST_GIT, "-C", fresh, "rev-parse", "--verify", `refs/heads/${branch}^{commit}`]);
  if (head.code !== 0) return { ok: false, reason: `the fresh clone has no branch ${branch}` };
  const tip = head.stdout.trim();
  if (tip === from) return { ok: true, head: tip };
  const current = await exec("git", [...HOST_GIT, "-C", cardClone, "rev-parse", "--verify", `refs/heads/${branch}^{commit}`]);
  if (current.code !== 0 || current.stdout.trim() !== from) return { ok: false, reason: `the card's branch is no longer at ${from.slice(0, 7)}` };
  const ref = "refs/luna/brought-back";
  const fetched = await exec("git", [...HOST_GIT, "-C", cardClone, "fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "--end-of-options", fresh, `+refs/heads/${branch}:${ref}`], { timeoutMs: CLONE_TIMEOUT_MS });
  if (fetched.code !== 0) return { ok: false, reason: `fetch from the fresh clone failed: ${(fetched.stderr || fetched.stdout).trim()}` };
  try {
    if ((await exec("git", [...HOST_GIT, "-C", cardClone, "merge-base", "--is-ancestor", from, tip])).code !== 0) return { ok: false, reason: "the fresh clone's history does not descend from the commit it was made at" };
    const merged = await exec("git", [...HOST_GIT, "-C", cardClone, "merge", "--ff-only", "--quiet", "--no-verify-signatures", tip]);
    return merged.code === 0 ? { ok: true, head: tip } : { ok: false, reason: `not a fast-forward: ${(merged.stderr || merged.stdout).trim()}` };
  } finally {
    await exec("git", [...HOST_GIT, "-C", cardClone, "update-ref", "-d", ref]);
  }
}

/** A PR task's clone at `path`: the PR's head branch fetched from the repository's remote, checked out and tracking `origin/<headRef>`, so a fix lands on the PR's own branch. An existing clone is reused. */
export async function ensurePrClone(repoPath: string, headRef: string, path: string): Promise<void> {
  if (existsSync(join(path, ".git"))) {
    await clearStaleLock(path);
    return;
  }
  if (!isBranchName(headRef)) throw new Error(`not a usable branch name: ${JSON.stringify(headRef)}`);
  const fetched = await exec("git", [...HOST_GIT, "-C", repoPath, "fetch", "--quiet", "--end-of-options", "origin", `+refs/heads/${headRef}:refs/remotes/origin/${headRef}`], { timeoutMs: CLONE_TIMEOUT_MS });
  if (fetched.code !== 0) throw new Error(`git fetch origin ${headRef} failed: ${(fetched.stderr || fetched.stdout).trim()}`);
  const sha = await execOrThrow("git", [...HOST_GIT, "-C", repoPath, "rev-parse", "--verify", `refs/remotes/origin/${headRef}^{commit}`]);
  await cloneInto(repoPath, path, headRef, sha);
  await execOrThrow("git", [...HOST_GIT, "-C", path, "update-ref", `refs/remotes/origin/${headRef}`, sha]);
  await execOrThrow("git", [...HOST_GIT, "-C", path, "branch", "--set-upstream-to", `origin/${headRef}`, headRef]);
}

/** The commits in a clone that no remote-tracking ref holds, newest first. */
export async function unpushedCommits(path: string): Promise<string[]> {
  const out = await exec("git", [...HOST_GIT, "-C", path, "log", "HEAD", "--not", "--remotes", "--format=%H"]);
  return out.code === 0 ? out.stdout.split("\n").map((l) => l.trim()).filter(Boolean) : [];
}

/**
 * What a container must not write inside a clone, relative to the clone: the config, hooks and
 * info the host's git reads as configuration or code, the object store's `info` (alternates),
 * and the same in every submodule's git dir. Only paths that exist, since a mount creates what is missing.
 */
export function sealedPaths(clonePath: string): string[] {
  const sealed: string[] = [];
  const add = (gitDir: string, names: string[]) => {
    for (const name of names) if (existsSync(join(clonePath, gitDir, name))) sealed.push(`${gitDir}/${name}`);
  };
  add(".git", ["config", "hooks", "info", "objects/info"]);
  const walk = (gitDir: string) => {
    const modules = join(clonePath, gitDir, "modules");
    let names: string[] = [];
    try {
      names = readdirSync(modules);
    } catch {
      return;
    }
    for (const name of names) {
      const sub = `${gitDir}/modules/${name}`;
      if (!statSync(join(clonePath, sub)).isDirectory()) continue;
      add(sub, ["config", "hooks", "info", "objects/info"]);
      walk(sub);
    }
  };
  walk(".git");
  return sealed;
}

/** `device:inode` of the clone's `.git` directory, or null when it is not a directory: a container that moved it aside and made another shows as a different stamp. */
export function gitDirStamp(clonePath: string): string | null {
  try {
    const stat = statSync(join(clonePath, ".git"));
    return stat.isDirectory() ? `${stat.dev}:${stat.ino}` : null;
  } catch {
    return null;
  }
}

/** The fresh clone Verify runs on, beside the card's clone as `<clone>.verify-<run>`: made at the card's head, brought back as a fast-forward, removed with the folder. */
export const hostFreshWorkspace = {
  async make(cardPath: string, branch: string, runId: string): Promise<{ path: string; commit: string }> {
    const path = `${cardPath}.verify-${runId.replace(/[^A-Za-z0-9]/g, "").slice(0, 48)}`;
    rmSync(path, { recursive: true, force: true });
    const commit = await headCommit(cardPath);
    await freshClone(cardPath, commit, branch, path);
    return { path, commit };
  },
  bringBack: (cardPath: string, freshPath: string, branch: string, from: string) => bringBack(cardPath, freshPath, branch, from),
  async remove(path: string): Promise<void> {
    rmSync(path, { recursive: true, force: true });
  },
};
