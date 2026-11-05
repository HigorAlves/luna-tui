// Patch coverage: how many of the lines a change added a repo's own lcov report saw run. Pure:
// the caller reads the report and the diff.
import type { CoverageSummary, Finding } from "@hardness/contracts";

const UNCOVERED_CAP = 50;

/** An lcov report as file → line → hits. A leading `/work/` (the container's mount) or the worktree's
 *  own path (`root`: a check run on the host) is stripped, and a relative path gets the check's `cwd`
 *  in front, so keys are worktree-relative. */
export function parseLcov(text: string, options: { cwd?: string; root?: string } = {}): Map<string, Map<number, number>> {
  const files = new Map<string, Map<number, number>>();
  const root = options.root ? `${options.root.replace(/\/+$/, "")}/` : null;
  let current: Map<number, number> | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("SF:")) {
      let path = line.slice(3).trim();
      if (path.startsWith("/work/")) path = path.slice("/work/".length);
      else if (root && path.startsWith(root)) path = path.slice(root.length);
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

const pct = (n: number): string => `${Math.round(n * 100)}%`;
const FILES_NAMED = 10;

/** One `should_fix` finding of category `tests` when the patch's coverage is below `1 - dropMax` of the added lines, naming the files with uncovered lines.
 *  `dropMax` is a fraction; a value above 1 is read as a percentage (the schema allows up to 100). Null at or above the bar, or with no added lines. */
export function coverageFinding(summary: CoverageSummary, dropMax: number): Finding | null {
  const { added, covered } = summary.total;
  if (added === 0) return null;
  const bar = 1 - (dropMax > 1 ? dropMax / 100 : dropMax);
  if (covered / added >= bar) return null;
  const files = summary.files.filter((f) => f.uncovered.length > 0);
  const named = files.slice(0, FILES_NAMED).map((f) => `${f.path} (${f.uncovered.slice(0, 8).join(", ")})`).join("; ");
  return {
    path: files[0]?.path ?? "",
    line: files[0]?.uncovered[0] ?? 0,
    start_line: null,
    severity: "should_fix",
    category: "tests",
    title: `coverage: ${pct(covered / added)} of the added lines are covered`,
    body: `${covered} of ${added} added lines are covered (${pct(covered / added)}), below the ${pct(bar)} the repository asks for\nuncovered: ${named}`,
    suggestion_code: null,
    confidence: 0.9,
  };
}

/** The score a mutation run printed: its last line of the form `mutation score: 0.82` or `mutation score: 82%` (case, `-`, `_` and `=` in place of `:` allowed).
 *  A bare number is a fraction and must be 0 to 1; a percentage 0 to 100. Anything else is null: the output is data, never trusted past this. */
export function parseMutationScore(output: string): number | null {
  const lines = [...output.matchAll(/^\s*mutation[\s_-]score\s*[:=]\s*(\d+(?:\.\d+)?)\s*(%?)\s*$/gim)];
  const last = lines.at(-1);
  if (!last) return null;
  const n = Number(last[1]);
  const score = last[2] ? n / 100 : n;
  return score >= 0 && score <= 1 ? score : null;
}

/** A `should_fix` finding when the mutation score is under the repository's minimum. */
export function mutationFinding(score: number, min: number): Finding | null {
  if (score >= min) return null;
  return {
    path: "",
    line: 0,
    start_line: null,
    severity: "should_fix",
    category: "tests",
    title: `mutation score ${pct(score)} is below the ${pct(min)} the repository asks for`,
    body: "the mutation run left more mutants alive than the repository allows: the tests do not notice changes to the added code",
    suggestion_code: null,
    confidence: 0.9,
  };
}
