// The ui-designer helper's git (RFC 0013, phase 5). The one invariant: the card's branch moves only by fast-forward, and only
// the machine moves it. Here the machine makes the helper's workspace, takes the helper's commits into the card's repository
// `M`, cherry-picks them onto the card's tip by plumbing (`merge-tree --write-tree` and `commit-tree`: no work tree, no index,
// no branch), and writes the bundle the implementer's container fetches. `advanceBranch` (bundles.ts) then moves the branch.
//
// The helper's repository `M'` is read like a fetch from an untrusted server: its hooks never run (HOST_GIT), nothing of its
// config is read for anything executable (git ignores a repository's own `uploadpack.*` and `core.*` command settings when it
// serves a fetch, and HOST_GIT switches off the rest), and every object is checked (`fetch.fsckObjects`), as the bundle importer does.
import { randomUUID } from "node:crypto";
import { renameSync, rmSync } from "node:fs";

import picomatch from "picomatch";

import { exec } from "../process/exec.ts";
import { freshClone, removeClone } from "./clone.ts";
import { machineGitDir } from "./machine-repo.ts";
import { MANIFEST } from "../../domain/delegation.ts";
import { HOST_GIT } from "./worktree.ts";

export { advanceBranch } from "./bundles.ts";

/** The most commits the machine takes from one helper run. */
export const MAX_HELPER_COMMITS = 20;
/** The oldest git whose `merge-tree --write-tree --merge-base` the pick needs. */
export const MIN_GIT = { major: 2, minor: 40 } as const;

const FETCH_TIMEOUT_MS = 300_000;
const SHA = /^[0-9a-f]{40,64}$/;
const TASK = /^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$/;
const REF_PREFIX = "refs/luna/helper/";

const validSlice = (slice: number): boolean => Number.isInteger(slice) && slice >= 1 && slice <= 999;
function assertNames(task: string, slice: number): void {
  if (!TASK.test(task)) throw new Error(`not a usable task id: ${JSON.stringify(task)}`);
  if (!validSlice(slice)) throw new Error(`not a usable slice number: ${JSON.stringify(slice)}`);
}

/** Where the helper's tip is kept in the card's repository: `base` when the helper starts, its tip once its commits are taken. */
export const helperRef = (task: string, slice: number): string => (assertNames(task, slice), `${REF_PREFIX}${task}/${slice}`);
/** Where the tip of the machine's own picks is kept. */
export const pickedRef = (task: string, slice: number): string => `${helperRef(task, slice)}-picked`;
/** The helper's branch in its own workspace. */
export const helperBranch = (slice: number): string => (assertNames("x", slice), `luna-helper-${slice}`);

const firstLine = (r: { stdout: string; stderr: string }): string => ((r.stderr || r.stdout).trim().split("\n")[0] ?? "").slice(0, 300);

/** A git version's text ("git version 2.47.3"), or null when it is new enough for the pick; otherwise what is wrong, for a boot note. */
export function gitVersionProblem(text: string): string | null {
  const m = /git version (\d+)\.(\d+)/.exec(text);
  if (!m) return `could not read the git version (${text.trim().slice(0, 80)}); the helper's pick needs git ${MIN_GIT.major}.${MIN_GIT.minor} or newer`;
  const [major, minor] = [Number(m[1]), Number(m[2])];
  return major > MIN_GIT.major || (major === MIN_GIT.major && minor >= MIN_GIT.minor) ? null : `git ${major}.${minor} is older than ${MIN_GIT.major}.${MIN_GIT.minor}: the helper's pick (merge-tree --write-tree --merge-base) is not available`;
}

/** The boot check: null when this host's git can do the pick. */
export async function checkGit(): Promise<string | null> {
  const out = await exec("git", [...HOST_GIT, "--version"]);
  return gitVersionProblem(out.code === 0 ? out.stdout : out.stderr);
}

export const helperWorkspace = {
  /** A new workspace for the helper at `base`, beside the card's as `<card>.helper-<slice>-<attempt>`, on `luna-helper-<slice>`; the helper ref in the card's repository starts at `base`. */
  async make(cardPath: string, base: string, task: string, slice: number, attempt: number): Promise<{ path: string; branch: string; ref: string }> {
    const ref = helperRef(task, slice);
    if (!Number.isInteger(attempt) || attempt < 1 || attempt > 99) throw new Error(`not a usable attempt: ${JSON.stringify(attempt)}`);
    const path = `${cardPath}.helper-${slice}-${attempt}`;
    const branch = helperBranch(slice);
    removeClone(path);
    await freshClone(cardPath, base, branch, path);
    const set = await exec("git", [...HOST_GIT, "--git-dir=" + machineGitDir(cardPath), "update-ref", ref, base]);
    if (set.code !== 0) throw new Error(`could not record ${ref}: ${firstLine(set)}`);
    return { path, branch, ref };
  },
  async remove(path: string): Promise<void> {
    removeClone(path);
  },
};

export type TakeResult =
  | { ok: true; tip: string; commits: string[] }
  | { ok: false; reason: "no_branch" | "fetch_failed" | "not_descendant" | "merge_commit" | "gitlink" | "too_many" | "locked_file" | "out_of_slice"; detail: string; files?: string[] };

const refuse = (reason: Extract<TakeResult, { ok: false }>["reason"], detail: string, files?: string[]): TakeResult => ({ ok: false, reason, detail, ...(files ? { files } : {}) });

/** Whether a path is held by an entry of `locked`: the path itself, a directory above it, or a glob. */
function heldBy(path: string, locked: readonly string[]): boolean {
  return locked.some((entry) => {
    const bare = entry.replace(/^\.\//, "");
    if (bare === path) return true;
    if (/[*?{]/.test(bare)) return picomatch.isMatch(path, bare, { dot: true });
    return path.startsWith(`${bare.replace(/\/$/, "")}/`);
  });
}

/** What a helper's take refuses whatever the slice plans: manifests and lockfiles, anything under `.github/`, and `protectedPaths`. */
const alwaysRefused = (path: string, protectedPaths: readonly string[]): boolean => MANIFEST.test(path) || path.startsWith(".github/") || protectedPaths.includes(path);

const dirOf = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf("/")));

/**
 * Fetches the helper's branch from its repository `M'` into the card's `M` (as `bringBack` fetches, with every object checked) and
 * moves the helper ref to its tip, after checks: the tip descends from `base`, `base..tip` has no merge, no gitlink (in any commit)
 * and at most MAX_HELPER_COMMITS commits, and no commit touches a file of `options.locked` (the implementer's; a rename away counts).
 * With `options.allowed` (the slice's planned files), every touched path must be a planned path or a file new at `base` in a directory of a planned
 * file; a manifest, a lockfile, anything under `.github/` and `options.protectedPaths` are refused as `out_of_slice` even when planned.
 * A refusal leaves the helper ref where it was. Never throws for a helper's own doing.
 */
export async function takeHelperCommits(cardPath: string, helperPath: string, task: string, slice: number, base: string, options: { locked?: readonly string[]; allowed?: readonly string[]; protectedPaths?: readonly string[] } = {}): Promise<TakeResult> {
  assertNames(task, slice);
  if (!SHA.test(base)) return refuse("fetch_failed", "the base is not a commit id");
  const git = (...args: string[]) => exec("git", [...HOST_GIT, "--git-dir=" + machineGitDir(cardPath), ...args]);
  const temp = `refs/luna/helper-in/${task}/${slice}`;
  const fetched = await exec(
    "git",
    [...HOST_GIT, "--git-dir=" + machineGitDir(cardPath), "-c", "fetch.fsckObjects=true", "-c", "transfer.fsckObjects=true", "-c", "fetch.recurseSubmodules=false", "fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "--end-of-options", machineGitDir(helperPath), `+refs/heads/${helperBranch(slice)}:${temp}`],
    { timeoutMs: FETCH_TIMEOUT_MS },
  );
  try {
    if (fetched.code !== 0) return refuse(/couldn't find remote ref/.test(fetched.stderr) ? "no_branch" : "fetch_failed", firstLine(fetched));
    const head = await git("rev-parse", "--verify", `${temp}^{commit}`);
    if (head.code !== 0) return refuse("fetch_failed", "the helper's branch holds no commit");
    const tip = head.stdout.trim();
    if (tip === base) return { ok: true, tip, commits: [] };
    if ((await git("merge-base", "--is-ancestor", base, tip)).code !== 0) return refuse("not_descendant", `the helper's commits do not descend from ${base.slice(0, 7)}`);
    const range = `${base}..${tip}`;
    const merges = await git("rev-list", "--merges", range);
    if (merges.code !== 0 || merges.stdout.trim()) return refuse("merge_commit", merges.code !== 0 ? "the helper's range could not be read" : "the helper's range holds a merge commit");
    const listed = await git("rev-list", "--reverse", "--topo-order", range);
    if (listed.code !== 0) return refuse("fetch_failed", "the helper's range could not be read");
    const commits = listed.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
    if (commits.length > MAX_HELPER_COMMITS) return refuse("too_many", `${commits.length} commits, over the ${MAX_HELPER_COMMITS} the machine takes`);
    // A nested repository would make host git start a child in the folder and read its own configuration: refused in any commit, not only in the net change.
    const raw = await git("log", "--raw", "--no-renames", "--ignore-submodules=none", "--format=", range);
    if (raw.code !== 0 || /^:\d{6} 160000 /m.test(raw.stdout)) return refuse("gitlink", raw.code !== 0 ? "the helper's changes could not be read" : "the helper's commits add or change a nested repository (a gitlink, mode 160000)");
    if (options.locked?.length || options.allowed) {
      const names = await git("log", "--name-only", "--no-renames", "--format=", "-z", range);
      if (names.code !== 0) return refuse("fetch_failed", "the helper's files could not be read");
      const touched = [...new Set(names.stdout.split("\0").map((l) => l.replace(/^\n/, "")).filter(Boolean))];
      const held = touched.filter((f) => options.locked?.length && heldBy(f, options.locked));
      if (held.length > 0) return refuse("locked_file", `the helper's commits touch ${held.length} file(s) the implementer holds`, held);
      if (options.allowed) {
        const planned = new Set(options.allowed.map((p) => p.replace(/^\.\//, "")));
        const dirs = new Set([...planned].map(dirOf));
        const stray: string[] = [];
        for (const f of touched) {
          if (alwaysRefused(f, options.protectedPaths ?? [])) stray.push(f);
          else if (planned.has(f)) continue;
          else if (dirs.has(dirOf(f)) && (await git("cat-file", "-e", `${base}:${f}`)).code !== 0) continue;
          else stray.push(f);
        }
        if (stray.length > 0) return refuse("out_of_slice", `the helper's commits touch ${stray.length} file(s) outside its slice`, stray);
      }
    }
    const moved = await git("update-ref", helperRef(task, slice), tip);
    if (moved.code !== 0) return refuse("fetch_failed", `could not record the helper's tip: ${firstLine(moved)}`);
    return { ok: true, tip, commits };
  } finally {
    await git("update-ref", "-d", temp);
  }
}

export type PickResult = { ok: true; picked: string[]; tip: string } | { ok: false; conflict: true; files: string[] } | { ok: false; conflict: false; reason: string };

/**
 * Cherry-picks `commits` (oldest first) onto `onto` in the card's repository, by plumbing: one new commit per commit, with the same
 * tree a cherry-pick would make, the original author and date, `identity` as committer, and the message plus
 * "(cherry picked from commit <sha>)" and `trailer`. Writes no work tree and no index and moves no branch; the tip is recorded at
 * `refs/luna/helper/<task>/<slice>-picked`. A conflict answers `{ conflict: true, files }` and records nothing; it never throws.
 */
export async function pickOnto(cardPath: string, onto: string, commits: readonly string[], identity: { name: string; email: string }, trailer: string, target: { task: string; slice: number }): Promise<PickResult> {
  assertNames(target.task, target.slice);
  const fail = (reason: string): PickResult => ({ ok: false, conflict: false, reason });
  if (!SHA.test(onto) || !commits.every((c) => SHA.test(c))) return fail("not a commit id");
  const git = (...args: string[]) => exec("git", [...HOST_GIT, "--git-dir=" + machineGitDir(cardPath), ...args]);
  let tip = onto;
  const picked: string[] = [];
  for (const c of commits) {
    const merged = await git("merge-tree", "--write-tree", "--name-only", "--no-messages", `--merge-base=${c}^`, tip, c);
    if (merged.code === 1) return { ok: false, conflict: true, files: merged.stdout.trim().split("\n").slice(1).filter(Boolean) };
    if (merged.code !== 0) return fail(firstLine(merged) || "merge-tree failed");
    const tree = (merged.stdout.split("\n")[0] ?? "").trim();
    if (!SHA.test(tree)) return fail("merge-tree answered no tree");
    const meta = await git("log", "-1", "--format=%an%x00%ae%x00%aI%x00%B", c);
    if (meta.code !== 0) return fail(`could not read ${c.slice(0, 7)}`);
    const [name = "", email = "", date = "", ...rest] = meta.stdout.split("\0");
    const message = `${rest.join("\0").trimEnd()}\n\n(cherry picked from commit ${c})\n${trailer}`;
    const made = await exec("git", [...HOST_GIT, "--git-dir=" + machineGitDir(cardPath), "-c", "commit.gpgsign=false", "commit-tree", tree, "-p", tip, "-m", message], {
      env: { ...process.env, GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_AUTHOR_DATE: date, GIT_COMMITTER_NAME: identity.name, GIT_COMMITTER_EMAIL: identity.email },
    });
    const sha = made.stdout.trim();
    if (made.code !== 0 || !SHA.test(sha)) return fail(firstLine(made) || "commit-tree failed");
    picked.push(sha);
    tip = sha;
  }
  if (picked.length > 0) {
    const set = await git("update-ref", pickedRef(target.task, target.slice), tip);
    if (set.code !== 0) return fail(`could not record the picked tip: ${firstLine(set)}`);
  }
  return { ok: true, picked, tip };
}

/** Whether `ancestor` is `descendant` or one of its ancestors in the card's repository; false on anything else, a bad id included. */
export async function isAncestor(cardPath: string, ancestor: string, descendant: string): Promise<boolean> {
  if (!SHA.test(ancestor) || !SHA.test(descendant)) return false;
  return (await exec("git", [...HOST_GIT, "--git-dir=" + machineGitDir(cardPath), "merge-base", "--is-ancestor", ancestor, descendant])).code === 0;
}

/** A bundle of `tipRef` over `from` (what the implementer's container fetches), written to a temporary name beside `dest` and renamed into place. */
export async function pickBundle(cardPath: string, from: string, tipRef: string, dest: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!SHA.test(from) || !tipRef.startsWith(REF_PREFIX) || tipRef.includes("..") || tipRef.startsWith("-")) return { ok: false, reason: "not a commit id or a helper ref" };
  const temp = `${dest}.tmp-${randomUUID()}`;
  try {
    const made = await exec("git", [...HOST_GIT, "--git-dir=" + machineGitDir(cardPath), "bundle", "create", "--quiet", temp, tipRef, `^${from}`], { timeoutMs: FETCH_TIMEOUT_MS });
    if (made.code !== 0) return { ok: false, reason: firstLine(made) || "git bundle failed" };
    renameSync(temp, dest);
    return { ok: true };
  } finally {
    rmSync(temp, { force: true });
  }
}

/**
 * Brings the card's folder `W` from `from` to `to` after the branch moved there (the implementer's container is gone): the index is put back at `from`
 * (`advanceBranch` set it at `to`, and `read-tree -m` from there would leave the folder alone), then `read-tree -m -u from to` writes the changed files.
 * A file the pick changes that holds local edits (or an untracked file in its way) refuses it: `{ ok: false, files }`, the folder untouched and the index back at `to`.
 */
export async function landInWorktree(cardPath: string, from: string, to: string): Promise<{ ok: true } | { ok: false; files: string[] }> {
  if (!SHA.test(from) || !SHA.test(to)) return { ok: false, files: [] };
  const git = (...args: string[]) => exec("git", [...HOST_GIT, "--git-dir=" + machineGitDir(cardPath), "--work-tree=" + cardPath, ...args]);
  if ((await git("read-tree", from)).code !== 0) return { ok: false, files: [] };
  // A freshly read index has no stat data, so every entry would be "not uptodate": refresh it (a file with local edits stays modified, and `read-tree -m` then names it).
  await git("update-index", "-q", "--refresh");
  const merged = await git("read-tree", "-m", "-u", from, to);
  if (merged.code === 0) return { ok: true };
  await git("read-tree", to);
  const files = [...new Set([...merged.stderr.matchAll(/(?:Entry|file) '([^']+)'/g)].map((m) => m[1]!))];
  return { ok: false, files };
}
