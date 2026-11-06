// What the diff itself says about four of scope_check's six questions, by script (RFC 0006 wave 18). Only a "no" is a fact: a diff with a
// new dependency line proves `no_new_dependency` should have been false, a diff with none does not prove it true (the plan may have
// called for it, or the manifest may be one this list does not know), so a question with no finding is left out. `planned_or_declared`
// and `unrelated_refactors` have no script and get no automatic truth. Pure.
import { redact } from "./evidence-markdown.ts";

export type ScopeFacts = Partial<Record<"no_new_dependency" | "no_test_removed" | "no_todo" | "no_secret_or_pii", false>>;

const MANIFEST = /(^|\/)(package\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|Cargo\.toml|Cargo\.lock|go\.mod|go\.sum|requirements[^/]*\.txt|pyproject\.toml|poetry\.lock|Gemfile|Gemfile\.lock|composer\.json|composer\.lock)$/;
const TEST_FILE = /(\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)(tests?|__tests__)\/|_test\.(go|py)$|(^|\/)test_[^/]*\.py$)/;
const TEST_CASE = /^\s*(it|test|describe)(\.\w+)?\s*\(|^\s*func Test\w+\(|^\s*def test_\w+\(|^\s*#\[test\]/;
const TODO = /\b(TODO|FIXME|XXX)\b/;
/** A line that declares a dependency: a quoted name with a version, a lockfile entry, a Cargo or go.mod line. */
const DEPENDENCY_LINE = /^\s*("[^"]+"\s*:\s*"[^"]*"|[\w@/.-]+@[\w.^~<>=*-]+:?|[\w-]+\s*=\s*("[^"]*"|\{)|require\s|[\w./-]+\s+v?\d+\.\d+|[\w.-]+(==|>=|~=)[\w.]+)/;

interface FileDiff {
  path: string;
  deleted: boolean;
  added: string[];
  removed: string[];
}

function parse(diff: string): FileDiff[] {
  const files: FileDiff[] = [];
  let current: FileDiff | null = null;
  for (const line of diff.split("\n")) {
    const header = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (header) {
      current = { path: header[2]!, deleted: false, added: [], removed: [] };
      files.push(current);
    } else if (!current) continue;
    else if (line.startsWith("deleted file mode") || line === "+++ /dev/null") current.deleted = true;
    else if (line.startsWith("+++") || line.startsWith("---")) continue;
    else if (line.startsWith("+")) current.added.push(line.slice(1));
    else if (line.startsWith("-")) current.removed.push(line.slice(1));
  }
  return files;
}

export function scopeFacts(diff: string): ScopeFacts {
  const facts: ScopeFacts = {};
  for (const file of parse(diff)) {
    if (MANIFEST.test(file.path) && file.added.some((line) => DEPENDENCY_LINE.test(line) && !file.removed.some((r) => r.trim().split(/[:=\s]/)[0] === line.trim().split(/[:=\s]/)[0]))) facts.no_new_dependency = false;
    if (TEST_FILE.test(file.path)) {
      const removedCases = file.removed.filter((line) => TEST_CASE.test(line)).length;
      const addedCases = file.added.filter((line) => TEST_CASE.test(line)).length;
      if (file.deleted || (removedCases > 0 && addedCases === 0)) facts.no_test_removed = false;
    }
    if (file.added.some((line) => TODO.test(line))) facts.no_todo = false;
    if (file.added.some((line) => redact(line) !== line)) facts.no_secret_or_pii = false;
  }
  return facts;
}
