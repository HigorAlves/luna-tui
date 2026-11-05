// The machine's own repository for each card. A card's work folder `W` is mounted into a container, so
// nothing in it (its `.git` included) can be trusted: git reads configuration, filters, hooks, refs and
// objects from wherever a writable git directory points. So the host never runs git in `W/.git`. Each card
// has `M`, a git directory the machine owns, under the machine's state directory and never mounted anywhere;
// every host-side git command on a workspace names `M` as its git directory and `W` as its work tree.
import { createHash } from "node:crypto";
import { type Dirent, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

let root = join(tmpdir(), "luna-machine-repos");

/** Where the machine keeps the repositories it owns (`<state dir>/repos`); set once at boot. */
export function configureMachineRepos(dir: string): void {
  root = resolve(dir);
}

let workspacesRoot: string | null = null;

/** Where the cards' work folders live (`config.worktreesDir`): a path under it is a workspace, whatever else is true of it. */
export function configureWorkspacesDir(dir: string): void {
  workspacesRoot = resolve(dir);
}

/** Whether `path` is inside the workspaces directory. Git that takes "a path" and is not pinned fails closed for such a path. */
export function isUnderWorkspaces(path: string): boolean {
  if (!workspacesRoot) return false;
  const p = resolve(path);
  return p === workspacesRoot || p.startsWith(`${workspacesRoot}/`);
}

export const machineRepoRoot = (): string => root;

/** `M` for the workspace at `path`: derived from the path, so every helper handed a workspace finds it. */
export function machineGitDir(path: string): string {
  return join(root, `${createHash("sha256").update(resolve(path)).digest("hex").slice(0, 32)}.git`);
}

/**
 * The arguments that pin a git command to a workspace: its folder as the working directory and work tree, the
 * machine's repository as the git directory. With no repository for the workspace git refuses ("not a git
 * repository"): it never falls back to looking for `.git` in the folder. Follows `...HOST_GIT`.
 */
export function at(path: string): string[] {
  const work = resolve(path);
  return ["-C", work, `--git-dir=${machineGitDir(work)}`, `--work-tree=${work}`];
}

/**
 * The first `.git` entry (a folder, a file or a link) found below the top level of the work folder, relative to it; null when
 * there is none. Nothing is followed: a link is looked at, never entered. A nested repository is data the host must not hand to
 * git: with a gitlink in the card's repository, `status`, `diff` and `add -A` start a child git inside it, which reads that
 * repository's own configuration (a clean filter there runs as the user). The top level's `.git` is the agent's scratch repository.
 */
export function findNestedRepository(path: string): string | null {
  const stack: string[] = [""];
  while (stack.length > 0) {
    const rel = stack.pop()!;
    let entries: Dirent[];
    try {
      entries = readdirSync(join(path, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === ".git" && rel !== "") return join(rel, entry.name);
      if (entry.isDirectory() && entry.name !== ".git") stack.push(join(rel, entry.name));
    }
  }
  return null;
}

/** A work folder holds a nested repository: no host git reads such a folder. */
export class NestedRepositoryError extends Error {
  constructor(public readonly entry: string) {
    super(`the work folder holds a nested repository (${entry}): host git does not read a folder with one`);
    this.name = "NestedRepositoryError";
  }
}

/** Throws `NestedRepositoryError` when the folder holds a nested repository. Run before any host git that reads the work tree. */
export function assertNoNestedRepository(path: string): void {
  const found = findNestedRepository(path);
  if (found) throw new NestedRepositoryError(found);
}

/** Removes every nested `.git` entry by plain file removal (no git is run in it), answering what was removed. */
export function removeNestedRepositories(path: string): string[] {
  const removed: string[] = [];
  for (let found = findNestedRepository(path); found && removed.length < 1000; found = findNestedRepository(path)) {
    rmSync(join(path, found), { recursive: true, force: true });
    removed.push(found);
  }
  return removed;
}
