// A card's workspace is its own clone: nothing in it is shared with the user's repository,
// so nothing a container does there can move one of the repository's branches or touch its
// objects, config or hooks. The machine copies in only the settings a push needs.
import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

import { exec, execOrThrow } from "../process/exec.ts";
import { HOST_GIT, type Workspace, clearStaleLock, startPoint } from "./worktree.ts";

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
  mkdirSync(dirname(workspace.path), { recursive: true });
  const cloned = await exec("git", [...HOST_GIT, "clone", "--quiet", "--no-hardlinks", "--no-checkout", "--origin", "origin", "--", repoPath, workspace.path], { timeoutMs: CLONE_TIMEOUT_MS });
  if (cloned.code !== 0) throw new Error(`git clone failed: ${(cloned.stderr || cloned.stdout).trim() || `exit code ${cloned.code}`}`);
  await execOrThrow("git", [...HOST_GIT, "-C", workspace.path, "checkout", "--quiet", "-b", workspace.branch, sha]);
  // The settings a push needs, taken from the repository; a repository with no remote leaves origin at its path.
  const settings = await copiedSettings(repoPath);
  for (const key of new Set(settings.map(([k]) => k))) await exec("git", [...HOST_GIT, "-C", workspace.path, "config", "--local", "--unset-all", key]);
  for (const [key, value] of settings) await execOrThrow("git", [...HOST_GIT, "-C", workspace.path, "config", "--local", "--add", key, value]);
}
