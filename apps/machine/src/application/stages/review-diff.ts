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
