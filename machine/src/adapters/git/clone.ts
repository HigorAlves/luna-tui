// A card's workspace: a work folder `W` (what a container sees at /work) and `M`, the machine's own bare git
// directory for the card (adapters/git/machine-repo.ts), which no container ever sees. `M` holds the card's branch,
// the only remotes and the push settings copied from the user's repository; the host runs git only there, with
// `W` as the work tree. Whatever a container leaves in `W` (its own `.git` included) is data, never configuration.
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { exec, execOrThrow } from "../process/exec.ts";
import { at, machineGitDir } from "./machine-repo.ts";
import { HOST_GIT, type Workspace, branchExists, clearStaleLock, headCommit, isBranchName, startPoint } from "./worktree.ts";

const CLONE_TIMEOUT_MS = 300_000;

/** The settings of a repository's config a push needs, and nothing else.
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

/** The local config entries a repository has that a card's repository keeps, as `[key, value]` pairs in file order. `gitArgs` names it: `["-C", repo]` or `["--git-dir=<M>"]`. */
export async function copiedSettings(gitArgs: string[]): Promise<Array<[string, string]>> {
  const out = await exec("git", [...HOST_GIT, ...gitArgs, "config", "--local", "-z", "--list"]);
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

/** Whether `path` is a card's workspace: it has a repository of the machine's. A linked worktree of the user's repository is not. */
export const isClone = (path: string): boolean => existsSync(machineGitDir(path));

const inMachine = (path: string) => ["--git-dir=" + machineGitDir(path)];

/** The objects directory of a repository of the user's (the common one, for a linked worktree). */
const objectsOf = (repoPath: string): Promise<string> => execOrThrow("git", [...HOST_GIT, "-C", repoPath, "rev-parse", "--path-format=absolute", "--git-path", "objects"]);

/**
 * A new repository for the workspace at `path`, with `branch` at `sha`. Its history is borrowed in place from `objects`
 * (the user's repository, or another card's `M`) through alternates: nothing is copied, and the host never writes through
 * them, so the repository holds only the card's own new objects. `origin` is `fallbackOrigin` unless `settingsFrom` names one.
 */
async function seedMachineRepo(path: string, objects: string, sha: string, branch: string, settingsFrom: string[], fallbackOrigin: string): Promise<void> {
  const machine = machineGitDir(path);
  rmSync(machine, { recursive: true, force: true });
  mkdirSync(dirname(machine), { recursive: true });
  await execOrThrow("git", [...HOST_GIT, "init", "--bare", "--quiet", machine]);
  mkdirSync(join(machine, "objects", "info"), { recursive: true });
  writeFileSync(join(machine, "objects", "info", "alternates"), `${objects}\n`);
  const git = (...args: string[]) => execOrThrow("git", [...HOST_GIT, ...inMachine(path), ...args]);
  await git("config", "gc.auto", "0");
  const present = await exec("git", [...HOST_GIT, ...inMachine(path), "cat-file", "-e", `${sha}^{commit}`]);
  if (present.code !== 0) throw new Error(`the commit ${sha.slice(0, 7)} is not in ${objects}`);
  await git("update-ref", `refs/heads/${branch}`, sha);
  await git("symbolic-ref", "HEAD", `refs/heads/${branch}`);
  // What the repository already had is not the card's to lose: it counts as pushed from the start.
  await git("update-ref", "refs/luna/pushed/base", sha);
  // The push settings of the repository the card belongs to; with no remote, origin is the repository itself.
  const settings = await copiedSettings(settingsFrom);
  if (!settings.some(([key]) => key === "remote.origin.url")) await git("config", "remote.origin.url", fallbackOrigin);
  for (const [key, value] of settings) await git("config", "--local", "--add", key, value);
}

/** Puts the branch's files in `path` and the index in step with it. The folder is the card's; the repository is the machine's. */
async function checkoutWork(path: string, branch: string): Promise<void> {
  mkdirSync(path, { recursive: true });
  await execOrThrow("git", [...HOST_GIT, ...at(path), "checkout", "--quiet", "--force", branch]);
}

/**
 * Creates the card's workspace unless it exists: the card's repository, seeded with the branch from origin's default
 * branch after a fetch in the user's repository (its HEAD with no origin), and the work folder checked out from it.
 * An existing workspace is reused and a stale `index.lock` cleared.
 */
export async function ensureClone(repoPath: string, workspace: Workspace): Promise<void> {
  const machine = machineGitDir(workspace.path);
  if (existsSync(machine)) {
    if (!existsSync(workspace.path)) await checkoutWork(workspace.path, workspace.branch);
    await clearStaleLock(workspace.path);
    return;
  }
  const start = await startPoint(repoPath);
  const sha = await execOrThrow("git", [...HOST_GIT, "-C", repoPath, "rev-parse", "--verify", `${start}^{commit}`]);
  await seedMachineRepo(workspace.path, await objectsOf(repoPath), sha, workspace.branch, ["-C", repoPath], repoPath);
  await checkoutWork(workspace.path, workspace.branch);
}

/**
 * Moves a card's linked worktree to a workspace of its own before its next writable run: the same branch at the same
 * commit, uncommitted and untracked work carried over, the worktree removed from the repository, and the repository's
 * local branch deleted only when the card's repository holds the same head. A workspace that is already one (or missing) is left alone.
 */
export async function moveToClone(repoPath: string, workspace: Workspace): Promise<void> {
  const old = workspace.path;
  if (!existsSync(join(old, ".git")) || isClone(old)) return;
  // One-time migration of a worktree made before cards had their own repository: its HEAD is read once, here.
  const head = await execOrThrow("git", [...HOST_GIT, "-C", old, "rev-parse", "HEAD"]); // legacy worktree
  const staging = `${old}.moving`;
  rmSync(staging, { recursive: true, force: true });
  // Seed under the final path's name: the repository is keyed by the folder it serves.
  await seedMachineRepo(old, await objectsOf(repoPath), head, workspace.branch, ["-C", repoPath], repoPath);
  mkdirSync(staging, { recursive: true });
  // The work tree as the agent left it: every entry but the git link, symlinks kept as links.
  for (const name of readdirSync(old)) {
    if (name !== ".git") cpSync(join(old, name), join(staging, name), { recursive: true, verbatimSymlinks: true, force: true });
  }
  const keep = await exec("git", [...HOST_GIT, "-C", repoPath, "rev-parse", "--verify", "--quiet", `refs/heads/${workspace.branch}`]);
  await execOrThrow("git", [...HOST_GIT, "-C", repoPath, "worktree", "remove", "--force", old]);
  rmSync(old, { recursive: true, force: true });
  renameSync(staging, old);
  // The index in step with the branch, the files as they are: what differs shows as the agent's uncommitted work.
  await execOrThrow("git", [...HOST_GIT, ...at(old), "read-tree", workspace.branch]);
  if (keep.code === 0 && keep.stdout.trim() === head && (await branchExists(repoPath, workspace.branch))) {
    await exec("git", [...HOST_GIT, "-C", repoPath, "branch", "-D", "--", workspace.branch]);
  }
}

/** A PR task's workspace at `path`: the PR's head branch fetched from the repository's remote, checked out and tracking `origin/<headRef>`, so a fix lands on the PR's own branch. An existing workspace is reused. */
export async function ensurePrClone(repoPath: string, headRef: string, path: string): Promise<void> {
  if (isClone(path)) {
    if (!existsSync(path)) await checkoutWork(path, headRef);
    await clearStaleLock(path);
    return;
  }
  if (!isBranchName(headRef)) throw new Error(`not a usable branch name: ${JSON.stringify(headRef)}`);
  const fetched = await exec("git", [...HOST_GIT, "-C", repoPath, "fetch", "--quiet", "--end-of-options", "origin", `+refs/heads/${headRef}:refs/remotes/origin/${headRef}`], { timeoutMs: CLONE_TIMEOUT_MS });
  if (fetched.code !== 0) throw new Error(`git fetch origin ${headRef} failed: ${(fetched.stderr || fetched.stdout).trim()}`);
  const sha = await execOrThrow("git", [...HOST_GIT, "-C", repoPath, "rev-parse", "--verify", `refs/remotes/origin/${headRef}^{commit}`]);
  await seedMachineRepo(path, await objectsOf(repoPath), sha, headRef, ["-C", repoPath], repoPath);
  await execOrThrow("git", [...HOST_GIT, ...inMachine(path), "update-ref", `refs/remotes/origin/${headRef}`, sha]);
  await execOrThrow("git", [...HOST_GIT, ...inMachine(path), "branch", "--set-upstream-to", `origin/${headRef}`, headRef]);
  await checkoutWork(path, headRef);
}

/**
 * Gives the agent a git repository of its own in `W/.git` before a run: the old one is deleted (plain file removal, no git
 * run in it), a shallow clone of the card's branch (depth 50, nothing shared) is made from the card's repository into a
 * folder the machine owns beside the work folder, its remote removed so no host path or setting is left in its config, and
 * its `.git` is moved in. From then on it is the agent's, and the host never reads it. The work tree already equals the
 * branch tip (a retry resets it), so the new index is set to the tip and the agent starts clean.
 */
export async function refreshScratch(path: string, branch: string): Promise<void> {
  if (!isBranchName(branch)) throw new Error(`not a usable branch name: ${JSON.stringify(branch)}`);
  rmSync(join(path, ".git"), { recursive: true, force: true });
  const staging = `${path}.scratch`;
  rmSync(staging, { recursive: true, force: true });
  const cloned = await exec("git", [...HOST_GIT, "clone", "--quiet", "--depth=50", "--no-hardlinks", "--no-checkout", "--single-branch", "--branch", branch, "--", `file://${machineGitDir(path)}`, staging], { timeoutMs: CLONE_TIMEOUT_MS });
  if (cloned.code !== 0) throw new Error(`git clone failed: ${(cloned.stderr || cloned.stdout).trim() || `exit code ${cloned.code}`}`);
  // The folder is the machine's own and brand new: git may run in it.
  await execOrThrow("git", [...HOST_GIT, "-C", staging, "remote", "remove", "origin"]); // scratch staging
  await execOrThrow("git", [...HOST_GIT, "-C", staging, "reset", "--quiet"]); // scratch staging
  renameSync(join(staging, ".git"), join(path, ".git"));
  rmSync(staging, { recursive: true, force: true });
}

/** The commits in a workspace's repository that the machine has not pushed (nothing under `refs/luna/pushed/*` holds them), newest first. */
export async function unpushedCommits(path: string): Promise<string[]> {
  const out = await exec("git", [...HOST_GIT, ...at(path), "log", "HEAD", "--not", "--glob=refs/luna/pushed/*", "--format=%H"]);
  return out.code === 0 ? out.stdout.split("\n").map((l) => l.trim()).filter(Boolean) : [];
}

/** Removes a workspace and its repository. */
export function removeClone(path: string): void {
  rmSync(path, { recursive: true, force: true });
  rmSync(machineGitDir(path), { recursive: true, force: true });
}

/**
 * A new workspace at exactly `sha`, on `branch`, in a new folder: where Verify and fixes run. Its repository is cloned
 * from the card's (both the machine's), so nothing is shared with it, and takes the card's origin and push settings.
 */
export async function freshClone(cardPath: string, sha: string, branch: string, path: string): Promise<void> {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`not a commit id: ${JSON.stringify(sha)}`);
  if (!isBranchName(branch)) throw new Error(`not a usable branch name: ${JSON.stringify(branch)}`);
  if (existsSync(path) || existsSync(machineGitDir(path))) throw new Error(`${path} exists already`);
  const card = machineGitDir(cardPath);
  await seedMachineRepo(path, join(card, "objects"), sha, branch, ["--git-dir=" + card], card);
  await checkoutWork(path, branch);
}

/**
 * Brings the commits made in a fresh workspace back into the card's: only as a fast-forward of the card's branch from `from`
 * (the commit the fresh workspace was made at). The card's branch must still be at `from` and the fresh branch must descend
 * from it; anything else is refused and nothing of the card changes. Both repositories are the machine's.
 */
export async function bringBack(cardPath: string, freshPath: string, branch: string, from: string): Promise<{ ok: true; head: string } | { ok: false; reason: string }> {
  if (!/^[0-9a-f]{40}$/.test(from) || !isBranchName(branch)) return { ok: false, reason: "not a commit id or a branch name" };
  const head = await exec("git", [...HOST_GIT, ...at(freshPath), "rev-parse", "--verify", `refs/heads/${branch}^{commit}`]);
  if (head.code !== 0) return { ok: false, reason: `the fresh workspace has no branch ${branch}` };
  const tip = head.stdout.trim();
  if (tip === from) return { ok: true, head: tip };
  const current = await exec("git", [...HOST_GIT, ...at(cardPath), "rev-parse", "--verify", `refs/heads/${branch}^{commit}`]);
  if (current.code !== 0 || current.stdout.trim() !== from) return { ok: false, reason: `the card's branch is no longer at ${from.slice(0, 7)}` };
  const ref = "refs/luna/brought-back";
  const fetched = await exec("git", [...HOST_GIT, ...at(cardPath), "fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "--end-of-options", machineGitDir(freshPath), `+refs/heads/${branch}:${ref}`], { timeoutMs: CLONE_TIMEOUT_MS });
  if (fetched.code !== 0) return { ok: false, reason: `fetch from the fresh workspace failed: ${(fetched.stderr || fetched.stdout).trim()}` };
  try {
    if ((await exec("git", [...HOST_GIT, ...at(cardPath), "merge-base", "--is-ancestor", from, tip])).code !== 0) return { ok: false, reason: "the fresh branch does not descend from the commit it was made at" };
    const merged = await exec("git", [...HOST_GIT, ...at(cardPath), "merge", "--ff-only", "--quiet", "--no-verify-signatures", tip]);
    return merged.code === 0 ? { ok: true, head: tip } : { ok: false, reason: `not a fast-forward: ${(merged.stderr || merged.stdout).trim()}` };
  } finally {
    await exec("git", [...HOST_GIT, ...at(cardPath), "update-ref", "-d", ref]);
  }
}

/** The fresh workspace Verify runs on, beside the card's as `<card>.verify-<run>`: made at the card's head, brought back as a fast-forward, removed with its repository. */
export const hostFreshWorkspace = {
  async make(cardPath: string, branch: string, runId: string): Promise<{ path: string; commit: string }> {
    const path = `${cardPath}.verify-${runId.replace(/[^A-Za-z0-9]/g, "").slice(0, 48)}`;
    removeClone(path);
    const commit = await headCommit(cardPath);
    await freshClone(cardPath, commit, branch, path);
    return { path, commit };
  },
  bringBack: (cardPath: string, freshPath: string, branch: string, from: string) => bringBack(cardPath, freshPath, branch, from),
  async remove(path: string): Promise<void> {
    removeClone(path);
  },
};
