// The task branch's diff as the board shows it: one row per file against the merge base with
// the base branch, and one file's patch on request. Read-only; every command runs with HOST_GIT.
import type { TaskDiff, TaskDiffFile } from "@hardness/contracts";

import type { ExecResult } from "../process/exec.ts";
import { HOST_GIT } from "./worktree.ts";

export type GitExec = (command: string, args: string[]) => Promise<ExecResult>;

/** The task has no worktree, or the path is not a checkout anymore. */
export class NoWorktreeError extends Error {
  constructor(path: string | null) {
    super(path ? `${path} is not a git worktree` : "the task has no worktree");
    this.name = "NoWorktreeError";
  }
}

/** `?file=` named a path the diff has no row for (a typo, a glob, a path outside the branch's change). */
export class NoFileError extends Error {
  constructor(file: string) {
    super(`${JSON.stringify(file)} is not a file of this diff`);
    this.name = "NoFileError";
  }
}

/** The most of a single file's patch the answer carries; past it `truncated` is set. */
export const PATCH_CAP = 512 * 1024;

/** `git diff --numstat` rows; a binary file counts as zero lines, a rename goes by its new path. */
export function parseNumstat(text: string): Array<{ path: string; added: number; removed: number }> {
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [added = "", removed = "", ...rest] = line.split("\t");
      return { path: renamedTo(rest.join("\t")), added: Number(added) || 0, removed: Number(removed) || 0 };
    });
}

/** `old => new` or `dir/{old => new}/x` as numstat writes a rename; a plain path comes back as is. */
function renamedTo(path: string): string {
  const braced = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(path);
  if (braced) return `${braced[1]}${braced[3]}${braced[4]}`;
  const plain = path.split(" => ");
  return plain.length === 2 ? plain[1]! : path;
}

const STATUS: Record<string, TaskDiffFile["status"]> = { A: "A", C: "A", M: "M", T: "M", D: "D", R: "R" };

/** `git diff --name-status` rows: the status letter and the (new) path. */
function parseNameStatus(text: string): Array<{ path: string; status: TaskDiffFile["status"] }> {
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const parts = line.split("\t");
      const letter = (parts[0] ?? "").charAt(0);
      return { path: parts[parts.length - 1] ?? "", status: STATUS[letter] ?? "M" };
    });
}

/** The ref the branch is diffed against: origin's default branch, else `main`, else the repo's own HEAD. */
async function baseRef(exec: GitExec, worktreePath: string, repoPath: string | null): Promise<string | null> {
  const git = (cwd: string, ...args: string[]) => exec("git", [...HOST_GIT, "-C", cwd, ...args]);
  const origin = await git(worktreePath, "symbolic-ref", "--quiet", "refs/remotes/origin/HEAD");
  if (origin.code === 0 && origin.stdout.trim()) return origin.stdout.trim().replace(/^refs\/remotes\//, "");
  const main = await git(worktreePath, "rev-parse", "--verify", "--quiet", "main");
  if (main.code === 0) return "main";
  if (!repoPath) return null;
  const repoHead = await git(repoPath, "rev-parse", "HEAD");
  return repoHead.code === 0 ? repoHead.stdout.trim() || null : null;
}

/**
 * The branch in `worktreePath` against its merge base with the base branch. With `file`, the
 * answer also carries that one file's patch, cut at PATCH_CAP characters (on a line) with
 * `truncated: true`. Throws NoWorktreeError when the path has no HEAD, NoFileError when `file`
 * is not exactly one of the diff's paths: git never sees a path it did not report itself.
 */
export async function taskDiff(exec: GitExec, worktreePath: string, repoPath: string | null, file?: string): Promise<TaskDiff> {
  const git = async (...args: string[]) => {
    const result = await exec("git", [...HOST_GIT, "-C", worktreePath, ...args]);
    if (result.code !== 0) throw new Error(`git ${args[0]} failed: ${(result.stderr || result.stdout).trim()}`);
    return result.stdout;
  };
  const head = await exec("git", [...HOST_GIT, "-C", worktreePath, "rev-parse", "HEAD"]);
  if (head.code !== 0) throw new NoWorktreeError(worktreePath);
  const ref = await baseRef(exec, worktreePath, repoPath);
  // A worktree with no base to speak of (no origin, no main, no repo): the whole history is the change.
  const base = ref ? (await git("merge-base", "HEAD", ref)).trim() : (await git("rev-list", "--max-parents=0", "HEAD")).trim().split("\n")[0]!;
  const [numstat, nameStatus] = await Promise.all([git("diff", "-M", "--numstat", base, "HEAD"), git("diff", "-M", "--name-status", base, "HEAD")]);
  const counts = new Map(parseNumstat(numstat).map((row) => [row.path, row]));
  const files: TaskDiffFile[] = parseNameStatus(nameStatus).map(({ path, status }) => ({
    path,
    status,
    added: counts.get(path)?.added ?? 0,
    removed: counts.get(path)?.removed ?? 0,
  }));
  const diff: TaskDiff = { base, head: head.stdout.trim(), files };
  if (file !== undefined) {
    if (!files.some((f) => f.path === file)) throw new NoFileError(file);
    const patch = await git("diff", "-M", base, "HEAD", "--", file);
    if (patch.length > PATCH_CAP) {
      const cut = patch.lastIndexOf("\n", PATCH_CAP - 1);
      diff.patch = patch.slice(0, cut > 0 ? cut + 1 : PATCH_CAP);
      diff.truncated = true;
    } else {
      diff.patch = patch;
    }
  }
  return diff;
}
