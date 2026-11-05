// The machine's own repository for each card. A card's work folder `W` is mounted into a container, so
// nothing in it (its `.git` included) can be trusted: git reads configuration, filters, hooks, refs and
// objects from wherever a writable git directory points. So the host never runs git in `W/.git`. Each card
// has `M`, a git directory the machine owns, under the machine's state directory and never mounted anywhere;
// every host-side git command on a workspace names `M` as its git directory and `W` as its work tree.
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

let root = join(tmpdir(), "luna-machine-repos");

/** Where the machine keeps the repositories it owns (`<state dir>/repos`); set once at boot. */
export function configureMachineRepos(dir: string): void {
  root = resolve(dir);
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
