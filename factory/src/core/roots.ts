// The run's roots: the only places a stage's tools may name. A path is resolved the way the kernel
// will open it (relative to the worktree, symlinks followed; for a path that does not exist yet,
// its nearest existing parent) and must then lie under a root. Everything else is refused: the
// Codex home and its token, HOME, /proc's environ files, /etc, other runs' /tmp. A denylist of
// names could always be spelled another way (a glob, a symlink, /proc/self/cwd/..); a root
// cannot.
import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { posix } from "node:path";

/** Devices a command may name: they hold nothing and reach nothing. */
const DEVICES = new Set(["/dev/null", "/dev/stdin", "/dev/stdout", "/dev/stderr", "/dev/zero", "/dev/random", "/dev/urandom"]);

/** The deepest existing ancestor of `path`, resolved, with the rest appended. `path` is absolute
 *  and not normalized first, so `link/..` is resolved by the kernel the way open() would. */
/** Where the machine mounts the repo's code graph, read-only, in a stage container. */
export const GRAPH_ROOT = "/graph";
/** Where the graph of the card's own newest slice commit is mounted, read-only, when one exists. */
export const GRAPH_BRANCH_ROOT = "/graph-branch";

export function realPath(path: string): string {
  // One component at a time, so a link is followed even when what it points at does not exist
  // yet (realpath fails there, and resolving the parent instead would keep the link's own name
  // under /work while a write through it lands elsewhere). A loop, or too many links, resolves to
  // a path no root holds.
  const pending = posix.normalize(path).split("/").filter(Boolean);
  let current = "/";
  let hops = 0;
  while (pending.length > 0) {
    const part = pending.shift()!;
    if (part === "..") {
      current = posix.dirname(current);
      continue;
    }
    const next = posix.join(current, part);
    let link: string | null = null;
    try {
      if (lstatSync(next).isSymbolicLink()) link = readlinkSync(next);
    } catch {
      // Nothing there: the rest is taken as written.
    }
    if (link === null) {
      current = next;
      continue;
    }
    if (++hops > MAX_LINKS) return LOOP;
    const target = link.startsWith("/") ? link : posix.join(current, link);
    pending.unshift(...posix.normalize(target).split("/").filter(Boolean));
    current = "/";
  }
  return current;
}

/** Links followed before a path counts as a loop: Linux's own limit. */
const MAX_LINKS = 40;
/** What a loop resolves to: under no root, so whatever names it is refused. */
const LOOP = "/\u0000symlink-loop";

/** A root as the kernel sees it (macOS's /var is /private/var), or as given when it is missing. */
const realRoot = (root: string): string => {
  try {
    return realpathSync(root);
  } catch {
    return posix.normalize(root);
  }
};

/** Whether a directory entry is there, a link counting even when what it points at is not. */
const entryExists = (path: string): boolean => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

export const isUnder = (path: string, root: string): boolean => path === root || path.startsWith(root === "/" ? "/" : `${root}/`);

export interface ResolvedPath {
  /** The path as the kernel would open it, or null for a home path (`~`), which is never resolved. */
  real: string | null;
  /** Whether it is a harmless device such as /dev/null. */
  device: boolean;
}

/** `path` as the kernel would open it from `cwd`; `$HOME/` is the run's scratch folder, as the
 *  commands' HOME is. */
export function resolvePath(path: string, cwd: string, home: string): ResolvedPath {
  if (path.startsWith("~")) return { real: null, device: false };
  const expanded = path === "$HOME" || path === "${HOME}" ? home : path.replace(/^\$\{?HOME\}?\//, `${home}/`);
  const absolute = expanded.startsWith("/") ? expanded : `${cwd}/${expanded}`;
  if (DEVICES.has(posix.normalize(absolute))) return { real: posix.normalize(absolute), device: true };
  return { real: realPath(absolute), device: false };
}

/** Whether `real` lies under one of `roots`, each resolved as the kernel sees it. */
export const inRoots = (real: string, roots: string[]): boolean => roots.some((root) => isUnder(real, realRoot(root)));

/** The paths one argument may stand for: itself, a value after `=` (`--output=/x`, `GIT_DIR=/x`),
 *  a file URL's path, a value glued to a short option (`-o/tmp/x`). Only what could name a file:
 *  a slash, a leading `.` or `~`, or an existing name in the worktree. */
export function pathsIn(token: string, cwd: string): string[] {
  const candidates = [token];
  const eq = token.indexOf("=");
  if (eq !== -1) candidates.push(token.slice(eq + 1));
  if (/^-[^-]/.test(token)) {
    candidates.push(token.slice(2));
    const slash = token.indexOf("/");
    if (slash > 1 && token[slash - 1] !== ".") candidates.push(token.slice(slash));
  }
  const paths: string[] = [];
  for (const raw of candidates) {
    const file = /^file:(\/\/)?/i.exec(raw);
    const candidate = file ? raw.slice(file[0].length).replace(/^[^/]*(?=\/)/, "") : raw;
    if (candidate === "" || (!file && /^[a-z][a-z0-9+.-]*:\/\//i.test(candidate))) continue;
    if (candidate.includes("/") || candidate.startsWith(".") || candidate.startsWith("~") || entryExists(posix.join(cwd, candidate))) paths.push(candidate);
  }
  return paths;
}
