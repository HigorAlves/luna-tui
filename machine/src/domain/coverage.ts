// Patch coverage: how many of the lines a change added a repo's own lcov report saw run. Pure:
// the caller reads the report and the diff.
import type { CoverageSummary } from "@hardness/contracts";

const UNCOVERED_CAP = 50;

/** An lcov report as file → line → hits. A leading `/work/` (the container's mount) is stripped and
 *  a relative path gets the check's `cwd` in front, so keys are worktree-relative. */
export function parseLcov(text: string, options: { cwd?: string } = {}): Map<string, Map<number, number>> {
  const files = new Map<string, Map<number, number>>();
  let current: Map<number, number> | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("SF:")) {
      let path = line.slice(3).trim();
      if (path.startsWith("/work/")) path = path.slice("/work/".length);
      else if (!path.startsWith("/") && options.cwd) path = `${options.cwd.replace(/\/+$/, "")}/${path.replace(/^\.\//, "")}`;
      current = files.get(path) ?? new Map();
      files.set(path, current);
    } else if (line.startsWith("DA:") && current) {
      const [n, hits] = line.slice(3).split(",");
      const lineNo = Number(n);
      if (Number.isInteger(lineNo) && lineNo > 0) current.set(lineNo, (current.get(lineNo) ?? 0) + (Number(hits) || 0));
    } else if (line.startsWith("end_of_record")) current = null;
  }
  return files;
}

/** The new-file line numbers of the `+` lines in a unified diff, by file (`+++ b/<path>`). */
export function addedLineNumbers(diff: string): Map<string, number[]> {
  const added = new Map<string, number[]>();
  let file: string | null = null;
  let next = 0;
  let inHunk = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      file = null;
      inHunk = false;
    } else if (!inHunk && line.startsWith("+++ ")) {
      const target = line.slice(4).trim();
      file = target === "/dev/null" ? null : target.replace(/^b\//, "");
      if (file && !added.has(file)) added.set(file, []);
    } else if (line.startsWith("@@")) {
      const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (m) {
        next = Number(m[1]);
        inHunk = true;
      }
    } else if (inHunk && file) {
      if (line.startsWith("+")) added.get(file)!.push(next++);
      else if (line.startsWith(" ")) next++;
    }
  }
  return added;
}

/** For each changed file the report knows: the added lines it lists (executable), how many ran, and which did not. */
export function patchCoverage(input: { lcov: Map<string, Map<number, number>>; added: Map<string, number[]>; report: string }): CoverageSummary {
  const files: CoverageSummary["files"] = [];
  for (const [path, lines] of input.added) {
    const hits = input.lcov.get(path);
    if (!hits) continue;
    const executable = lines.filter((n) => hits.has(n));
    const uncovered = executable.filter((n) => (hits.get(n) ?? 0) === 0).sort((a, b) => a - b);
    files.push({ path, added: executable.length, covered: executable.length - uncovered.length, uncovered: uncovered.slice(0, UNCOVERED_CAP) });
  }
  return {
    files,
    total: { added: files.reduce((n, f) => n + f.added, 0), covered: files.reduce((n, f) => n + f.covered, 0) },
    report: input.report,
  };
}
