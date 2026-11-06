// Task worktrees on the host. Each task gets its own branch and checkout; the agent works
// there through a bind mount, and the machine commits on the host.
import { existsSync, lstatSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";

import { basename, dirname, join, resolve } from "node:path";

import { branchLinkOf, jiraBranch, slug } from "../../domain/jira-link.ts";
import { DEFAULT_JIRA_BRANCH } from "../../domain/policy.ts";
import { exec, execOrThrow } from "../process/exec.ts";
import { assertNoNestedRepository, at, isUnderWorkspaces, machineGitDir } from "./machine-repo.ts";

export { slug };

/** Every git command the machine runs on the host carries this: a stage can write into a
 *  workspace's .git dir, so a hook, a file-system monitor, an external diff driver, a submodule
 *  or an `ext::` transport it left there must never execute as you. */
export const HOST_GIT = [
  "--no-optional-locks",
  "--no-replace-objects",
  "-c", "core.hooksPath=/dev/null",
  "-c", "core.fsmonitor=",
  "-c", "diff.external=",
  "-c", "submodule.recurse=false",
  "-c", "protocol.ext.allow=never",
] as const;

export interface Workspace {
  branch: string;
  path: string;
}

/** Branch and checkout path for a task, following herdr's `<dir>/<repo>/<branch>` layout. A
 *  Jira-linked task takes the repo's `jira.branch` pattern (`{type}/{key}` by default, so
 *  `bug/PLAT-123`); every other task `task/<id8>-<slug>`. The checkout folder is the branch
 *  with `/` as `-`, so `bug/PLAT-123` lives in `<repo>/bug-PLAT-123`. */
export function workspaceFor(
  task: { id: string; title: string; route?: string; jira?: import("@hardness/contracts").JiraLink | null; source?: import("@hardness/contracts").TaskSource | null; card?: { splitFrom?: string; splitPart?: { n: number } } | null },
  repoPath: string,
  worktreesDir: string,
  jiraPattern?: string,
): Workspace {
  // A part of a split: the branch is built from ids alone, never a word of the title a model wrote.
  const part = task.card?.splitFrom && task.card.splitPart ? `task/${task.id.slice(0, 8)}-part-${task.card.splitPart.n}-of-${task.card.splitFrom.slice(0, 8)}` : null;
  if (part) return { branch: part, path: join(worktreesDir, basename(repoPath), part.replaceAll("/", "-")) };
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
  const linked = branchLinkOf({ jira: task.jira ?? null, source: task.source ?? null }) !== null;
  if (!linked || jiraPattern.includes("{id}") || jiraPattern.includes("{slug}")) return plain;
  if (!(await branchExists(repoPath, plain.branch))) return plain;
  return workspaceFor(task, repoPath, worktreesDir, `${jiraPattern}-{id}`);
}

/** The repo's default branch: what `origin/HEAD` points at, else the branch the checkout is on; null when neither is known. */
export async function defaultBranch(repoPath: string): Promise<string | null> {
  const head = await exec("git", [...HOST_GIT, "-C", repoPath, "symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
  if (head.code === 0) return head.stdout.trim().replace(/^refs\/remotes\/origin\//, "") || null;
  const current = await exec("git", [...HOST_GIT, "-C", repoPath, "symbolic-ref", "--quiet", "--short", "HEAD"]);
  return current.code === 0 ? current.stdout.trim() || null : null;
}

/** A command runner the rebase takes, so tests can record the git calls; the real one is `exec`. */
export type GitExec = (command: string, args: string[], options?: { cwd?: string; signal?: AbortSignal; timeoutMs?: number }) => Promise<{ code: number; stdout: string; stderr: string }>;

const FETCH_TIMEOUT = 60_000;

export type RebaseResult = { ok: true; onto: string } | { ok: false; error: string; conflicts: string[] };

/** A branch name git would accept as a positional: the default branch is read from a ref in the common git
 *  dir, which a writable stage can rewrite, so a name shaped like an option is never passed to git. */
const BRANCH_NAME = /^[A-Za-z0-9][\w./-]*$/;
export const isBranchName = (name: string): boolean => BRANCH_NAME.test(name) && !name.includes("..") && !name.includes("//") && !name.endsWith("/") && !name.endsWith(".lock");

/** Where a stacked card's base commit is recorded in its own repository (the machine's `M`), and the config key of the parent's branch name. Only the host writes either. */
export const BASE_REF = "refs/luna/base";
const BASE_KEY = "luna.baseBranch";

/** What the card's repository records of its stack: the base commit and the parent's branch name (null for a card that never had one, or that left its stack). */
export async function stackOf(path: string): Promise<{ sha: string | null; branch: string | null }> {
  const sha = await exec("git", [...HOST_GIT, ...at(path), "rev-parse", "--verify", "--quiet", `${BASE_REF}^{commit}`]);
  const branch = await exec("git", [...HOST_GIT, ...at(path), "config", "--local", "--get", BASE_KEY]);
  const name = branch.code === 0 ? branch.stdout.trim() : "";
  return { sha: sha.code === 0 && /^[0-9a-f]{40,64}$/.test(sha.stdout.trim()) ? sha.stdout.trim() : null, branch: isBranchName(name) ? name : null };
}

const hasGitlink = (raw: { code: number; stdout: string }): boolean => raw.code !== 0 || /^:\d{6} 160000 /m.test(raw.stdout);

/** Whether the change from `from` to `to` (from their merge base) adds or changes a gitlink (mode 160000) in the user's repository: a nested repository a stack must not carry in. Unreadable counts as yes. */
export async function repoAddsGitlink(run: GitExec, repoPath: string, from: string, to: string): Promise<boolean> {
  const mb = await run("git", [...HOST_GIT, "-C", repoPath, "merge-base", from, to]);
  const since = mb.code === 0 && mb.stdout.trim() ? mb.stdout.trim() : from;
  return hasGitlink(await run("git", [...HOST_GIT, "-C", repoPath, "diff", "--raw", "--no-renames", since, to]));
}

/** The same in a card's own repository (`from` and `to` are refs or commits there). */
async function workspaceAddsGitlink(run: GitExec, path: string, from: string, to: string): Promise<boolean> {
  const mb = await run("git", [...HOST_GIT, ...at(path), "merge-base", from, to]);
  const since = mb.code === 0 && mb.stdout.trim() ? mb.stdout.trim() : from;
  return hasGitlink(await run("git", [...HOST_GIT, ...at(path), "diff", "--raw", "--no-renames", since, to]));
}

const failed = (stage: string, out: { code: number; stdout: string; stderr: string }): RebaseResult => ({ ok: false, error: `${stage} failed: ${(out.stderr || out.stdout).trim() || `exit code ${out.code}`}`, conflicts: [] });

const conflictsOf = (out: { stdout: string }): string[] => out.stdout.split("\n").map((l) => l.trim()).filter(Boolean);

async function defaultTarget(defaultBranchOf: (repoPath: string) => Promise<string | null>, repoPath: string): Promise<string | RebaseResult> {
  const base = await defaultBranchOf(repoPath);
  return !base || !isBranchName(base) ? { ok: false, error: `no usable default branch: ${JSON.stringify(base ?? null)}`, conflicts: [] } : base;
}

/** The rebase of a card that is, or was, stacked: `--onto <onto> refs/luna/base` replays only the card's own commits; aborted when it stops (the folder is left as it was), with the files in conflict. Its commits are unsigned, as every commit the machine makes is. */
async function replayOwn(run: GitExec, worktreePath: string, onto: string, label: string): Promise<RebaseResult> {
  const rebased = await run("git", [...HOST_GIT, ...at(worktreePath), "-c", "commit.gpgsign=false", "rebase", "--onto", onto, BASE_REF]);
  if (rebased.code === 0) return { ok: true, onto: label };
  const unmerged = await run("git", [...HOST_GIT, ...at(worktreePath), "diff", "--name-only", "--diff-filter=U"]);
  await run("git", [...HOST_GIT, ...at(worktreePath), "rebase", "--abort"]);
  return { ok: false, error: (rebased.stderr || rebased.stdout).trim() || `exit code ${rebased.code}`, conflicts: conflictsOf(unmerged) };
}

/** The refusal a nested repository in the folder gets: a failed result, never a thrown error. */
function nestedRefusal(worktreePath: string): RebaseResult | null {
  try {
    assertNoNestedRepository(worktreePath);
    return null;
  } catch (error) {
    return { ok: false, error: (error as Error).message, conflicts: [] };
  }
}

/**
 * Rebases the task's worktree onto its base, once, and never pushes (the caller does). A rebase that stops is aborted
 * (the worktree is left as it was) and reports the files in conflict.
 * - A stacked card (`luna.baseBranch` recorded): the parent's branch is fetched from `origin`, a range that adds a
 *   gitlink is refused, `rebase --onto origin/<branch> refs/luna/base` replays only the card's own commits, and the recorded base moves to the new tip.
 * - A card that left its stack (a base commit and no branch): onto `origin/<default branch>` as below, and the recorded base moves there.
 * - A card with neither: onto `origin/<default branch>`, nothing recorded.
 */
export async function rebaseOntoBase(
  run: GitExec,
  worktreePath: string,
  repoPath: string,
  defaultBranchOf: (repoPath: string) => Promise<string | null> = defaultBranch,
): Promise<RebaseResult> {
  const recorded = await stackOf(worktreePath);
  if (recorded.sha && recorded.branch) {
    const nested = nestedRefusal(worktreePath);
    if (nested) return nested;
    const b = recorded.branch;
    const fetched = await run("git", [...HOST_GIT, ...at(worktreePath), "fetch", "--quiet", "--end-of-options", "origin", `+refs/heads/${b}:refs/remotes/origin/${b}`], { timeoutMs: FETCH_TIMEOUT });
    if (fetched.code !== 0) return failed("git fetch", fetched);
    const tip = await run("git", [...HOST_GIT, ...at(worktreePath), "rev-parse", "--verify", `refs/remotes/origin/${b}^{commit}`]);
    if (tip.code !== 0) return failed("reading the parent's branch", tip);
    if (await workspaceAddsGitlink(run, worktreePath, recorded.sha, tip.stdout.trim())) return { ok: false, error: "the parent's branch adds a nested repository (mode 160000): nothing was rebased", conflicts: [] };
    const result = await replayOwn(run, worktreePath, `refs/remotes/origin/${b}`, `origin/${b}`);
    if (result.ok) await run("git", [...HOST_GIT, ...at(worktreePath), "update-ref", BASE_REF, tip.stdout.trim()]);
    return result;
  }
  const base = await defaultTarget(defaultBranchOf, repoPath);
  if (typeof base !== "string") return base;
  // `--end-of-options`: whatever the name, it is a ref, never an option.
  const fetched = await run("git", [...HOST_GIT, ...at(worktreePath), "fetch", "--quiet", "--end-of-options", "origin", base], { timeoutMs: FETCH_TIMEOUT });
  if (fetched.code !== 0) return failed("git fetch", fetched);
  const rebased = await run("git", [...HOST_GIT, ...at(worktreePath), ...(recorded.sha ? ["-c", "commit.gpgsign=false"] : []), "rebase", `origin/${base}`]);
  if (rebased.code === 0) {
    if (recorded.sha) {
      const tip = await run("git", [...HOST_GIT, ...at(worktreePath), "rev-parse", "--verify", `origin/${base}^{commit}`]);
      if (tip.code === 0) await run("git", [...HOST_GIT, ...at(worktreePath), "update-ref", BASE_REF, tip.stdout.trim()]);
    }
    return { ok: true, onto: `origin/${base}` };
  }
  const unmerged = await run("git", [...HOST_GIT, ...at(worktreePath), "diff", "--name-only", "--diff-filter=U"]);
  await run("git", [...HOST_GIT, ...at(worktreePath), "rebase", "--abort"]);
  return { ok: false, error: (rebased.stderr || rebased.stdout).trim() || `exit code ${rebased.code}`, conflicts: conflictsOf(unmerged) };
}

/** The same function, under the name every caller before the stack used. */
export const rebaseOntoDefault = rebaseOntoBase;

/**
 * The card's parent merged: only the card's own commits (those after `refs/luna/base`) are replayed onto `origin/<default branch>`, the recorded
 * base moves to that commit and the parent's branch name is forgotten. A rebase that stops is aborted and nothing recorded changes.
 */
export async function unstack(
  run: GitExec,
  worktreePath: string,
  repoPath: string,
  defaultBranchOf: (repoPath: string) => Promise<string | null> = defaultBranch,
): Promise<RebaseResult> {
  const recorded = await stackOf(worktreePath);
  if (!recorded.sha) return { ok: false, error: "the card has no recorded base", conflicts: [] };
  const nested = nestedRefusal(worktreePath);
  if (nested) return nested;
  const base = await defaultTarget(defaultBranchOf, repoPath);
  if (typeof base !== "string") return base;
  const fetched = await run("git", [...HOST_GIT, ...at(worktreePath), "fetch", "--quiet", "--end-of-options", "origin", base], { timeoutMs: FETCH_TIMEOUT });
  if (fetched.code !== 0) return failed("git fetch", fetched);
  const tip = await run("git", [...HOST_GIT, ...at(worktreePath), "rev-parse", "--verify", `origin/${base}^{commit}`]);
  if (tip.code !== 0) return failed("reading the default branch", tip);
  const result = await replayOwn(run, worktreePath, `origin/${base}`, `origin/${base}`);
  if (result.ok) {
    await run("git", [...HOST_GIT, ...at(worktreePath), "update-ref", BASE_REF, tip.stdout.trim()]);
    await run("git", [...HOST_GIT, ...at(worktreePath), "config", "--local", "--unset", BASE_KEY]);
  }
  return result;
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

/** The read-only checkout the code graph is built from: `<dir>/<repo>/graph`. */
export const GRAPH_CHECKOUT = "graph";
/** The clean checkout a repo's graph is built from, keyed by the graph store's slug: two repos with one basename never share it. */
export function graphCheckoutPath(slug: string, worktreesDir: string): string {
  return join(worktreesDir, slug, GRAPH_CHECKOUT);
}

/** The commit `origin/<default>` points at after a fetch (the repo's HEAD without an origin). */
export async function defaultHead(repoPath: string): Promise<string> {
  return execOrThrow("git", [...HOST_GIT, "-C", repoPath, "rev-parse", await startPoint(repoPath)]);
}

/** Whether `ancestor` is an ancestor of (or the same commit as) `descendant`; false when either is unknown. */
export async function isAncestor(repoPath: string, ancestor: string, descendant: string): Promise<boolean> {
  return (await exec("git", [...HOST_GIT, "-C", repoPath, "merge-base", "--is-ancestor", ancestor, descendant])).code === 0;
}

/** The default branch as the repo last saw it (`origin/HEAD`, else HEAD); no fetch, so it is cheap to ask per card. */
async function lastKnownDefault(repoPath: string): Promise<string> {
  const head = await exec("git", [...HOST_GIT, "-C", repoPath, "symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
  return head.code === 0 ? head.stdout.trim().replace(/^refs\/remotes\//, "") : "HEAD";
}

/** How many commits the default branch has that `commit` lacks; null when either is unknown. */
export async function commitsBehind(repoPath: string, commit: string): Promise<number | null> {
  if (!/^[0-9a-f]{7,40}$/.test(commit)) return null;
  const out = await exec("git", [...HOST_GIT, "-C", repoPath, "rev-list", "--count", `${commit}..${await lastKnownDefault(repoPath)}`]);
  const n = Number.parseInt(out.stdout.trim(), 10);
  return out.code === 0 && Number.isFinite(n) ? n : null;
}

/** The first of `paths` that exists at the default branch, as text; null when none does. Reads the object database, never the checkout. */
export async function defaultBranchFile(repoPath: string, paths: string[], maxBytes = 262_144): Promise<string | null> {
  const ref = await lastKnownDefault(repoPath);
  for (const path of paths) {
    const out = await exec("git", [...HOST_GIT, "-C", repoPath, "show", `${ref}:${path}`]);
    if (out.code === 0 && out.stdout.length <= maxBytes) return out.stdout;
  }
  return null;
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
  // A read-only checkout (a linked worktree of the repo that no container can write): not a card's workspace.
  await execOrThrow("git", [...HOST_GIT, "-C", path, "reset", "--hard", "--quiet", sha]); // read-only checkout
  await execOrThrow("git", [...HOST_GIT, "-C", path, "clean", "-fd", "--quiet"]); // read-only checkout
  return path;
}

/**
 * HEAD of a read-only checkout the machine itself made with `ensureCleanCheckout` (the graph's and the Jira intake's), read from the
 * repository that registered it: `git worktree list` in `repoPath` names each linked checkout and its HEAD from the repository's own
 * administrative files, which no container can write. The checkout's own `.git` file is never opened and nothing in the folder is followed:
 * a folder that is a link, or is not a checkout the repository registered, is refused. A card's workspace is not read here (`headCommit`).
 */
export async function checkoutHead(repoPath: string, path: string): Promise<string> {
  const target = resolve(path);
  const info = lstatSync(target);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${target} is not a checkout the machine made`);
  const canonical = join(realpathSync(dirname(target)), basename(target));
  const listed = await execOrThrow("git", [...HOST_GIT, "-C", repoPath, "worktree", "list", "--porcelain"]);
  for (const block of listed.split(/\n\n+/)) {
    const lines = block.split("\n");
    if (lines[0] !== `worktree ${canonical}`) continue;
    const head = /^HEAD ([0-9a-f]{40,64})$/m.exec(block)?.[1];
    if (head) return head;
  }
  throw new Error(`${target} is not a checkout the repository registered`);
}

/** `origin/<default>` freshly fetched when the repo has an origin; HEAD otherwise. */
export async function startPoint(repoPath: string): Promise<string> {
  const head = await exec("git", [...HOST_GIT, "-C", repoPath, "symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
  if (head.code !== 0) return "HEAD";
  const ref = head.stdout.trim().replace(/^refs\/remotes\//, "");
  const fetched = await exec("git", [...HOST_GIT, "-C", repoPath, "fetch", "--quiet", "origin"], { timeoutMs: FETCH_TIMEOUT_MS });
  if (fetched.code !== 0) console.warn(`git fetch origin failed in ${repoPath}; basing on the last fetched ${ref}`);
  return ref;
}

export async function clearStaleLock(worktreePath: string): Promise<void> {
  // No git runs here. A card's workspace has its index in the machine's repository; a read-only checkout (a linked worktree
  // the machine made) names its git dir in its `.git` file.
  let lock = join(machineGitDir(worktreePath), "index.lock");
  if (!existsSync(machineGitDir(worktreePath))) {
    try {
      const pointer = /^gitdir: (.+)$/m.exec(readFileSync(join(worktreePath, ".git"), "utf8"));
      if (!pointer) return;
      lock = join(pointer[1]!.trim(), "index.lock");
    } catch {
      return;
    }
  }
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
  assertNoNestedRepository(path);
  await execOrThrow("git", [...HOST_GIT, ...at(path), "reset", "--hard", "--quiet", ref]);
  await execOrThrow("git", [...HOST_GIT, ...at(path), "clean", "-fd", "--quiet"]);
}

/** Removes a task's workspace from disk: a clone is deleted, a linked worktree is removed from its repository (its branch and commits stay). */
export async function removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
  if (existsSync(machineGitDir(worktreePath))) {
    rmSync(worktreePath, { recursive: true, force: true });
    rmSync(machineGitDir(worktreePath), { recursive: true, force: true });
    return;
  }
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
  return execOrThrow("git", [...HOST_GIT, "-C", repoPath, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
}

/** The commit the task branch forked from: the merge base of the worktree's HEAD and the
 *  repo's own HEAD (which may have moved on since). Null when either side is not a repo. */
export async function branchBase(worktreePath: string, repoPath: string): Promise<string | null> {
  // A stacked card is diffed against where it left its parent's branch: its own change only.
  const stacked = await exec("git", [...HOST_GIT, ...at(worktreePath), "merge-base", "HEAD", BASE_REF]);
  if (stacked.code === 0 && stacked.stdout.trim()) return stacked.stdout.trim();
  const repoHead = await exec("git", [...HOST_GIT, "-C", repoPath, "rev-parse", "HEAD"]);
  if (repoHead.code !== 0) return null;
  const head = repoHead.stdout.trim();
  // A clone shares no objects with the repo: when the repo moved on, bring its HEAD over (a read of the repo, never a write to it).
  if ((await exec("git", [...HOST_GIT, ...at(worktreePath), "cat-file", "-e", `${head}^{commit}`])).code !== 0) {
    await exec("git", [...HOST_GIT, ...at(worktreePath), "fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "--end-of-options", repoPath, head], { timeoutMs: FETCH_TIMEOUT_MS });
  }
  const base = await exec("git", [...HOST_GIT, ...at(worktreePath), "merge-base", "HEAD", head]);
  return base.code === 0 ? base.stdout.trim() || null : null;
}

/** The files the branch changed since it forked from the repo, worktree-relative; null when
 *  the base is unknown, so a caller runs every check rather than none. */
export async function changedPaths(worktreePath: string, repoPath: string): Promise<string[] | null> {
  const base = await branchBase(worktreePath, repoPath);
  if (!base) return null;
  const out = await exec("git", [...HOST_GIT, ...at(worktreePath), "diff", "--name-only", `${base}..HEAD`]);
  if (out.code !== 0) return null;
  return out.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
}

/** The files changed since `since` (a commit id the machine read), worktree-relative, for a delta check. Null when unknown: a ref that is not a commit id, a failed diff,
 *  or an empty delta, so a caller runs every check. Nothing changed is never a reason to run nothing. */
export async function changedSince(run: GitExec, worktreePath: string, since: string): Promise<string[] | null> {
  if (!/^[0-9a-f]{40,64}$/.test(since)) return null;
  const out = await run("git", [...HOST_GIT, ...at(worktreePath), "diff", "--name-only", `${since}..HEAD`]);
  if (out.code !== 0) return null;
  const names = out.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  return names.length > 0 ? names : null;
}

/** Lines added and removed on the branch since `base`, from `git diff --shortstat`. */
export async function diffShortstat(path: string, base: string): Promise<{ added: number; removed: number }> {
  const out = await execOrThrow("git", [...HOST_GIT, ...at(path), "diff", "--shortstat", `${base}..HEAD`]);
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

/** HEAD of the user's own repository (a checkout run reads it directly). */
export function repoHead(repoPath: string): Promise<string> {
  return execOrThrow("git", [...HOST_GIT, "-C", repoPath, "rev-parse", "HEAD"]);
}

/** The id of each lockfile (by its fixed name) in the tree of `commit` in the card's repository: what the commit holds, never a file in the folder. */
export async function lockfilesAt(path: string, commit: string, names: readonly string[]): Promise<Record<string, string>> {
  const found: Record<string, string> = {};
  if (!/^[0-9a-f]{40,64}$/.test(commit)) return found;
  for (const name of names) {
    const out = await exec("git", [...HOST_GIT, ...at(path), "rev-parse", "--verify", "--quiet", `${commit}:${name}`]);
    if (out.code === 0 && out.stdout.trim()) found[name] = out.stdout.trim();
  }
  return found;
}

/** The blob id of each named file in the tree of `commit` in the USER's own repository (its own git directory, as `repoHead` reads it): what the commit holds, never a file in a folder. */
export async function blobsAtRepo(repoPath: string, commit: string, names: readonly string[]): Promise<Record<string, string>> {
  const found: Record<string, string> = {};
  if (!/^[0-9a-f]{40,64}$/.test(commit)) return found;
  for (const name of names) {
    const out = await exec("git", [...HOST_GIT, "-C", repoPath, "rev-parse", "--verify", "--quiet", `${commit}:${name}`]);
    if (out.code === 0 && out.stdout.trim()) found[name] = out.stdout.trim();
  }
  return found;
}

export function headCommit(path: string): Promise<string> {
  return execOrThrow("git", [...HOST_GIT, ...at(path), "rev-parse", "HEAD"]);
}

/** `git diff --name-status <from> <to>` in `path`, for checking what a commit touched. */
export function diffNameStatus(path: string, from: string, to: string): Promise<string> {
  return execOrThrow("git", [...HOST_GIT, ...at(path), "diff", "--name-status", from, to]);
}

/** `git diff <from> <to>` in `path`: the unified diff, for reading what a change added. */
export function diffText(path: string, from: string, to: string): Promise<string> {
  return execOrThrow("git", [...HOST_GIT, ...at(path), "diff", "--no-color", "--no-ext-diff", from, to]);
}

/** Undoes one commit with a new commit on top (never rewrites history a person may have fetched). */
export async function revertCommit(path: string, sha: string): Promise<void> {
  assertNoNestedRepository(path);
  await execOrThrow("git", [...HOST_GIT, ...at(path), "-c", "commit.gpgsign=false", "revert", "--no-edit", sha]);
}

/** Puts `files` back as they are at `ref`, leaving HEAD alone (undo with resetWorktree). */
export async function restoreFiles(path: string, ref: string, files: string[]): Promise<void> {
  assertNoNestedRepository(path);
  await execOrThrow("git", [...HOST_GIT, ...at(path), "checkout", ref, "--", ...files]);
}

/**
 * Commits everything the agent changed. Returns the new commit, or null when nothing changed.
 * Commits are not signed: signing needs your passphrase, which a background run cannot ask for.
 */
export async function commitAll(path: string, message: string): Promise<string | null> {
  assertNoNestedRepository(path);
  await execOrThrow("git", [...HOST_GIT, ...at(path), "add", "-A"]);
  await refuseGitlinks(path, "HEAD");
  const staged = await exec("git", [...HOST_GIT, ...at(path), "diff", "--cached", "--quiet"]);
  if (staged.code === 0) return null;
  await execOrThrow("git", [...HOST_GIT, ...at(path), "-c", "commit.gpgsign=false", "commit", "-q", "-m", message]);
  return headCommit(path);
}

/** Fails, with the index put back to HEAD, when what is staged against `base` holds a gitlink (mode 160000): a nested repository the walk of the folder should have caught. */
export async function refuseGitlinks(path: string, base: string): Promise<void> {
  const raw = await execOrThrow("git", [...HOST_GIT, ...at(path), "diff", "--cached", "--raw", "--no-renames", base]);
  if (!/^:\d{6} 160000 /m.test(raw)) return;
  await exec("git", [...HOST_GIT, ...at(path), "read-tree", "HEAD"]);
  throw new Error("a nested repository (mode 160000) was staged; nothing was committed");
}

/** The new mode of each path in `git diff --raw` output (`:100644 120000 abc def A\tpath`), keyed by the new path. */
function modesOf(raw: string): Record<string, string> {
  const modes: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const m = /^:\d+ (\d+) \S+ \S+ [A-Z]\d*\t(?:[^\t]+\t)?(.+)$/.exec(line);
    if (m) modes[m[2]!] = m[1]!;
  }
  return modes;
}

/** Stages everything a stage left in the worktree (new files too) and reads what that adds to `base`, the commit the run started from: the name-status, the unified diff and each path's new mode. */
export async function stagePending(path: string, base: string): Promise<{ nameStatus: string; diff: string; modes: Record<string, string> }> {
  assertNoNestedRepository(path);
  await execOrThrow("git", [...HOST_GIT, ...at(path), "add", "-A"]);
  await refuseGitlinks(path, base);
  const [nameStatus, diff, raw] = await Promise.all([
    execOrThrow("git", [...HOST_GIT, ...at(path), "diff", "--cached", "--name-status", base]),
    execOrThrow("git", [...HOST_GIT, ...at(path), "diff", "--cached", "--no-color", "--no-ext-diff", base]),
    execOrThrow("git", [...HOST_GIT, ...at(path), "diff", "--cached", "--raw", base]),
  ]);
  return { nameStatus, diff, modes: modesOf(raw) };
}

/** What the commit `sha` changed, only when it is an ancestor of HEAD (the machine's own tests commit, never one found by its subject); null otherwise. */
export async function readCommitDiff(path: string, sha: string): Promise<{ nameStatus: string; diff: string; modes: Record<string, string>; parent: string } | null> {
  if (!/^[0-9a-f]{7,64}$/.test(sha)) return null;
  if ((await exec("git", [...HOST_GIT, ...at(path), "merge-base", "--is-ancestor", sha, "HEAD"])).code !== 0) return null;
  const [nameStatus, diff, raw, parent] = await Promise.all([
    execOrThrow("git", [...HOST_GIT, ...at(path), "show", "--name-status", "--format=", sha]),
    execOrThrow("git", [...HOST_GIT, ...at(path), "show", "--no-color", "--no-ext-diff", "--format=", sha]),
    execOrThrow("git", [...HOST_GIT, ...at(path), "show", "--raw", "--format=", sha]),
    execOrThrow("git", [...HOST_GIT, ...at(path), "rev-parse", `${sha}^`]).catch(() => ""),
  ]);
  return { nameStatus, diff, modes: modesOf(raw), parent };
}

/** The branch the worktree is on (`HEAD` when detached). */
export function currentBranch(path: string): Promise<string> {
  return execOrThrow("git", [...HOST_GIT, ...at(path), "rev-parse", "--abbrev-ref", "HEAD"]);
}

/** The commits between `sinceSha` and HEAD (`git log <sha>..HEAD`), newest first, each with its files' names and added and removed line counts (`--numstat`); never a diff, never selected by a date the agent could set. At most 100 commits, 200 files a commit and 300 characters of path; anything that is not a sha gives nothing. */
export async function commitsSince(path: string, sinceSha: string): Promise<Array<{ sha: string; files: Array<{ path: string; added: number; removed: number }> }>> {
  if (!/^[0-9a-f]{7,64}$/.test(sinceSha)) return [];
  const out = await exec("git", [...HOST_GIT, ...at(path), "log", `${sinceSha}..HEAD`, "-n", "100", "--numstat", "--format=commit %H"]);
  if (out.code !== 0) return [];
  const commits: Array<{ sha: string; files: Array<{ path: string; added: number; removed: number }> }> = [];
  for (const line of out.stdout.split("\n")) {
    if (line.startsWith("commit ")) {
      commits.push({ sha: line.slice(7).trim(), files: [] });
    } else if (line.trim() && commits.length > 0) {
      const [added, removed, ...name] = line.split("\t");
      const files = commits.at(-1)!.files;
      // A binary file counts "-": no line numbers to give.
      if (files.length < 200) files.push({ path: name.join("\t").slice(0, 300), added: Number(added) || 0, removed: Number(removed) || 0 });
    }
  }
  return commits;
}

/** What the worktree has uncommitted or untracked, one `git status --porcelain` line each. */
export async function dirtyFiles(path: string): Promise<string[]> {
  assertNoNestedRepository(path);
  const status = await execOrThrow("git", [...HOST_GIT, ...at(path), "status", "--porcelain"]);
  return status === "" ? [] : status.split("\n");
}

/** `owner/name` of the checkout's `origin` remote, or null when it has none or it is not on GitHub. */
export async function originSlugOf(cwd: string): Promise<string | null> {
  // A card's workspace answers from the machine's repository; a repository's own path from itself; a folder under the workspaces
  // directory with no repository of the machine's is nobody's to ask, so it fails closed (git there would read the folder's own `.git`).
  const pinned = existsSync(machineGitDir(cwd));
  if (!pinned && isUnderWorkspaces(cwd)) return null;
  const url = await exec("git", [...HOST_GIT, ...(pinned ? at(cwd) : ["-C", cwd]), "remote", "get-url", "origin"]);
  if (url.code !== 0) return null;
  const match = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?\s*$/.exec(url.stdout.trim());
  return match ? `${match[1]}/${match[2]}` : null;
}

/** A PR task's checkout: `<dir>/<repo>/pr-<number>-<head slug>`, beside the task worktrees. */
export function prWorktreePath(repoPath: string, worktreesDir: string, number: number, headRef: string): string {
  return join(worktreesDir, basename(repoPath), `pr-${number}-${slug(headRef)}`);
}

/**
 * A person retargeted a stacked card's PR to the default branch by hand (its parent is gone): nothing is replayed. The recorded base moves to
 * the merge base of the branch and `origin/<default branch>` and the parent's branch name is forgotten, so the card's diffs are what the PR now shows.
 */
export async function forgetBase(
  run: GitExec,
  worktreePath: string,
  repoPath: string,
  defaultBranchOf: (repoPath: string) => Promise<string | null> = defaultBranch,
): Promise<RebaseResult> {
  const recorded = await stackOf(worktreePath);
  if (!recorded.sha) return { ok: false, error: "the card has no recorded base", conflicts: [] };
  const nested = nestedRefusal(worktreePath);
  if (nested) return nested;
  const base = await defaultTarget(defaultBranchOf, repoPath);
  if (typeof base !== "string") return base;
  const fetched = await run("git", [...HOST_GIT, ...at(worktreePath), "fetch", "--quiet", "--end-of-options", "origin", base], { timeoutMs: FETCH_TIMEOUT });
  if (fetched.code !== 0) return failed("git fetch", fetched);
  const mergeBase = await run("git", [...HOST_GIT, ...at(worktreePath), "merge-base", "HEAD", `origin/${base}`]);
  if (mergeBase.code !== 0 || !/^[0-9a-f]{40,64}$/.test(mergeBase.stdout.trim())) return failed("reading the merge base", mergeBase);
  await run("git", [...HOST_GIT, ...at(worktreePath), "update-ref", BASE_REF, mergeBase.stdout.trim()]);
  await run("git", [...HOST_GIT, ...at(worktreePath), "config", "--local", "--unset", BASE_KEY]);
  return { ok: true, onto: `origin/${base}` };
}
