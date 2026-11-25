// The PR's diff as the review reads it: split per file, with the files nobody reviews (lockfiles, generated, vendored,
// snapshots) set aside before the diff is sized, and, for a diff too big for one reviewer, cut into shards by module.

/** One file's part of a unified diff. */
export interface DiffFile {
  path: string;
  /** The name a renamed file had before. */
  previousPath?: string;
  additions: number;
  deletions: number;
  /** The lines of `text`: what the reviewer reads and what a shard's size is counted in. */
  lines: number;
  /** The file's whole section, header included, ending in a newline. */
  text: string;
}

const headerPaths = (head: string): { path: string; previousPath?: string } => {
  const rest = head.slice("diff --git ".length);
  // `a/P b/P` when nothing was renamed: the halves are the same length.
  const half = (rest.length - 5) / 2;
  if (Number.isInteger(half) && rest.slice(2, 2 + half) === rest.slice(5 + half)) return { path: rest.slice(5 + half) };
  const at = rest.lastIndexOf(" b/");
  return at > 0 ? { path: rest.slice(at + 3), previousPath: rest.slice(rest.startsWith("a/") ? 2 : 0, at) } : { path: rest };
};

/** Splits a unified diff per file. */
export function parseDiff(diff: string): DiffFile[] {
  if (diff.trim() === "") return [];
  return diff
    .split(/^(?=diff --git )/m)
    .filter((part) => part.startsWith("diff --git "))
    .map((raw): DiffFile => {
      const text = raw.endsWith("\n") ? raw : `${raw}\n`;
      const rows = text.split("\n");
      rows.pop();
      let { path, previousPath } = headerPaths(rows[0]!);
      let inHunk = false;
      let additions = 0;
      let deletions = 0;
      for (const row of rows.slice(1)) {
        if (!inHunk) {
          if (row.startsWith("@@")) inHunk = true;
          else if (row.startsWith("rename to ")) path = row.slice("rename to ".length);
          else if (row.startsWith("rename from ")) previousPath = row.slice("rename from ".length);
          else if ((row.startsWith("+") && !row.startsWith("+++ ")) || (row.startsWith("-") && !row.startsWith("--- "))) inHunk = true;
          if (!inHunk || row.startsWith("@@")) continue;
        }
        if (row.startsWith("@@")) continue;
        if (row.startsWith("+")) additions++;
        else if (row.startsWith("-")) deletions++;
      }
      return { path, ...(previousPath && previousPath !== path ? { previousPath } : {}), additions, deletions, lines: rows.length, text };
    });
}

export type LeftOutReason = "lockfile" | "generated" | "vendored" | "snapshot";

const LOCKFILES = new Set([
  "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb", "Cargo.lock", "poetry.lock", "Pipfile.lock", "Gemfile.lock",
  "go.sum", "composer.lock", "uv.lock", "flake.lock", "mix.lock", "pubspec.lock", "Podfile.lock", "packages.lock.json", "gradle.lockfile", "Package.resolved",
]);
const GENERATED_DIRS = new Set(["dist", "build", "__generated__"]);
const VENDORED_DIRS = new Set(["vendor", "node_modules", "third_party"]);
const GENERATED_FILE = /(\.min\.(js|css)|\.map|\.pb\.go|_pb2\.py|\.g\.dart|(^|[._])generated\.[A-Za-z]+|_generated\.[A-Za-z]+)$/;

/** Why a review does not read this path, or null when it does: a lockfile, generated or minified output, a vendored dependency or a snapshot. */
export function leftOutOf(path: string): LeftOutReason | null {
  const parts = path.split("/");
  const name = parts[parts.length - 1]!;
  const dirs = parts.slice(0, -1);
  if (LOCKFILES.has(name)) return "lockfile";
  if (dirs.some((d) => VENDORED_DIRS.has(d))) return "vendored";
  if (dirs.includes("__snapshots__") || name.endsWith(".snap")) return "snapshot";
  if (dirs.some((d) => GENERATED_DIRS.has(d)) || GENERATED_FILE.test(name)) return "generated";
  return null;
}

export interface Skipped {
  path: string;
  lines: number;
  reason: LeftOutReason;
}

/** The files to review and the ones set aside, each with the lines it would have cost. */
export function splitReviewable(files: readonly DiffFile[]): { reviewable: DiffFile[]; skipped: Skipped[] } {
  const reviewable: DiffFile[] = [];
  const skipped: Skipped[] = [];
  for (const f of files) {
    const reason = leftOutOf(f.path);
    if (reason) skipped.push({ path: f.path, lines: f.lines, reason });
    else reviewable.push(f);
  }
  return { reviewable, skipped };
}

/** One file's share of a shard: the whole file, or a piece of it cut at hunk boundaries (every piece carries the file's header). */
export interface ShardPart {
  path: string;
  text: string;
  lines: number;
  piece?: { n: number; of: number };
}

export interface Shard {
  /** From 1, in the diff's order. */
  index: number;
  lines: number;
  parts: ShardPart[];
  /** The directories its files are in. */
  modules: string[];
}

const dirOf = (path: string): string => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ".");

/** How big a shard may be: lines, and characters (what the reviewer's prompt can carry whole). */
interface Size {
  lines: number;
  chars: number;
}
const overSize = (lines: number, chars: number, limit: Size): boolean => lines > limit.lines || chars > limit.chars;

/** Cuts a file bigger than `limit` into pieces at hunk boundaries, each with the file's header; one hunk bigger than `limit` stays whole. */
function cutFile(file: DiffFile, limit: Size): ShardPart[] {
  const rows = file.text.split("\n");
  rows.pop();
  const first = rows.findIndex((r) => r.startsWith("@@"));
  if (first < 0) return [{ path: file.path, text: file.text, lines: file.lines }];
  const header = rows.slice(0, first);
  const headerChars = header.reduce((n, r) => n + r.length + 1, 0);
  const hunks: string[][] = [];
  for (const row of rows.slice(first)) {
    if (row.startsWith("@@")) hunks.push([row]);
    else hunks[hunks.length - 1]!.push(row);
  }
  const groups: string[][][] = [];
  let lines = 0;
  let chars = 0;
  for (const hunk of hunks) {
    const hunkChars = hunk.reduce((n, r) => n + r.length + 1, 0);
    const last = groups[groups.length - 1];
    if (last && !overSize(header.length + lines + hunk.length, headerChars + chars + hunkChars, limit)) {
      last.push(hunk);
      lines += hunk.length;
      chars += hunkChars;
    } else {
      groups.push([hunk]);
      lines = hunk.length;
      chars = hunkChars;
    }
  }
  return groups.map((g, i): ShardPart => {
    const body = [...header, ...g.flat()];
    return { path: file.path, text: `${body.join("\n")}\n`, lines: body.length, ...(groups.length > 1 ? { piece: { n: i + 1, of: groups.length } } : {}) };
  });
}

/** Cuts the files to review into shards of about `lines` lines (and, when given, `chars` characters): a directory stays in one shard when it fits, a bigger one is split by file, and a file bigger than a shard is cut at hunk boundaries into shards of its own. */
export function shardDiff(files: readonly DiffFile[], lines: number, chars: number = Number.POSITIVE_INFINITY): Shard[] {
  const limit: Size = { lines, chars };
  const dirs = new Map<string, DiffFile[]>();
  for (const f of files) {
    const dir = dirOf(f.path);
    dirs.set(dir, [...(dirs.get(dir) ?? []), f]);
  }
  const done: ShardPart[][] = [];
  let cur: ShardPart[] = [];
  let curLines = 0;
  let curChars = 0;
  const close = (): void => {
    if (cur.length > 0) done.push(cur);
    cur = [];
    curLines = 0;
    curChars = 0;
  };
  const whole = (f: DiffFile): ShardPart => ({ path: f.path, text: f.text, lines: f.lines });
  const add = (f: DiffFile): void => {
    if (overSize(curLines + f.lines, curChars + f.text.length, limit)) close();
    cur.push(whole(f));
    curLines += f.lines;
    curChars += f.text.length;
  };
  for (const group of dirs.values()) {
    const totalLines = group.reduce((n, f) => n + f.lines, 0);
    const totalChars = group.reduce((n, f) => n + f.text.length, 0);
    if (!overSize(totalLines, totalChars, limit)) {
      if (overSize(curLines + totalLines, curChars + totalChars, limit)) close();
      for (const f of group) add(f);
      continue;
    }
    for (const f of group) {
      if (overSize(f.lines, f.text.length, limit)) {
        close();
        for (const piece of cutFile(f, limit)) done.push([piece]);
      } else add(f);
    }
  }
  close();
  return done.map((parts, i): Shard => ({ index: i + 1, lines: parts.reduce((n, p) => n + p.lines, 0), parts, modules: [...new Set(parts.map((p) => dirOf(p.path)))] }));
}

const SECURITY_WORDS = new Set([
  "auth", "authn", "authz", "oauth", "session", "sessions", "token", "tokens", "jwt", "crypto", "password", "secret", "secrets", "permission", "permissions", "acl", "rbac", "login",
  "middleware", "migration", "migrations", "sql", "upload", "uploads", "parser", "parsers", "exec", "api", "route", "routes",
]);

/** How much a path's review matters, 3 to 0: security-sensitive paths, then source, then tests, then docs. */
export function riskOf(path: string): 0 | 1 | 2 | 3 {
  const parts = path.toLowerCase().split("/");
  const name = parts[parts.length - 1]!;
  if (/\.(md|mdx|txt|rst)$/.test(name) || parts.slice(0, -1).includes("docs")) return 0;
  if (/(\.|_|-)(test|spec)\./.test(name) || parts.slice(0, -1).some((d) => ["test", "tests", "__tests__", "spec", "e2e", "fixtures"].includes(d))) return 1;
  return path.toLowerCase().split(/[/._-]/).some((w) => SECURITY_WORDS.has(w)) ? 3 : 2;
}

const shardRisk = (s: Shard): number => Math.max(...s.parts.map((p) => riskOf(p.path)));

/** Keeps the `max` shards that matter most (risk, then size, then the diff's order) in the diff's order and renumbered; every file of the others is returned as unreviewed, a cut file once with its pieces' lines added. */
export function capShards(shards: readonly Shard[], max: number): { kept: Shard[]; unreviewed: Array<{ path: string; lines: number }> } {
  if (shards.length <= max) return { kept: [...shards], unreviewed: [] };
  const ranked = [...shards].sort((a, b) => shardRisk(b) - shardRisk(a) || b.lines - a.lines || a.index - b.index);
  const keep = new Set(ranked.slice(0, max));
  const lines = new Map<string, number>();
  for (const s of ranked.slice(max)) for (const p of s.parts) lines.set(p.path, (lines.get(p.path) ?? 0) + p.lines);
  return {
    kept: shards.filter((s) => keep.has(s)).map((s, i) => ({ ...s, index: i + 1 })),
    unreviewed: [...lines].map(([path, n]) => ({ path, lines: n })),
  };
}
