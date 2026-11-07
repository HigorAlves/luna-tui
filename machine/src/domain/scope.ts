// The facts about a change's scope, computed from git and never asked of a model: which files it
// changed outside the plan, which tests it removed, what it added to a dependency manifest, which
// TODOs and secret-looking lines it added. scope_check judges the declared reasons against these. Pure.
import picomatch from "picomatch";

import { safe } from "./evidence-markdown.ts";
import { lockedFilesRemoved, looksLikeTestPath } from "./locked-files.ts";

/** A line a diff added, with its file and, in a toml file, the `[section]` it sits under. */
export interface AddedLine {
  path: string;
  line: string;
  section?: string;
}

export interface ScopeFacts {
  /** Every file the change touched (the new path of a rename). */
  changed: string[];
  /** Changed, not planned and not declared; empty when the plan names no files at all. */
  undeclared: string[];
  removedTests: string[];
  newDependencies: string[];
  todos: string[];
  secrets: string[];
  /** Tests switched off in place on an added line (`.skip`, `.only`, `xit`, `@Ignore`, `t.Skip`, `#[ignore]`, `pytest.mark.skip`...). */
  switchedOff: string[];
  /** Scenario ids whose `@scenario:<id>` tag the change removed from a test and did not put back: the test the tests step wrote was dropped or rewritten away. */
  weakened: string[];
}

export type ScopeSeverity = "blocker" | "should_fix" | "nit";
export interface ScopeIssue {
  severity: ScopeSeverity;
  /** The file the issue is about, when it is about one. */
  path?: string;
  kind: "undeclared_file" | "test_removed" | "switched_off_test" | "test_weakened" | "secret" | "new_dependency" | "unrelated_refactor" | "todo";
  text: string;
}

const TOML = /\.toml$/;
const HEADER = /^\[+([^\]]+)\]+\s*$/;
// A prefix alone is not a token: docs show `xoxp-…`, `ghp_...` and `KEY=xoxp-...` as placeholders. Each prefix needs a body as long as a real one.
const TOKEN = /xox[abposr]-[A-Za-z0-9-]{10,}|gh[oprsu]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,}|\bsk-[A-Za-z0-9_-]{20,}|\b[sr]k_(live|test)_[A-Za-z0-9]{10,}|AKIA[0-9A-Z]{12}|eyJ[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{35}|npm_[A-Za-z0-9]{36}|-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const SECRET_FILE = /(^|\/)(\.env(\..*)?|\.envrc|\.npmrc|id_(rsa|ecdsa|ed25519)|[^/]+\.(pem|key|p12|pfx))$/;
/** A match is named by its first four characters: the fact is that one exists, never its value. */

/** Whether a diff line belongs to a file's header block: git writes it after `diff --git` and before the first hunk. A content line is never a header, whatever it starts with. */
const HEADER_LINE = /^(diff |index |old mode|new mode|deleted file mode|new file mode|similarity index|dissimilarity index|rename from|rename to|copy from|copy to|Binary files|--- |\+\+\+ )/;

/** The added lines of a unified diff (`git diff <from> <to>`). A file header is read only inside the header block after a `diff --git` line. */
export function addedLinesOf(diff: string): AddedLine[] {
  const added: AddedLine[] = [];
  let path = "";
  let section: string | undefined;
  let header = false;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      header = true;
      path = "";
      section = undefined;
    } else if (header && raw.startsWith("+++ ")) {
      path = raw.slice(4).replace(/^b\//, "");
    } else if (raw.startsWith("@@")) {
      header = false;
      section = undefined;
    } else if (header && HEADER_LINE.test(raw)) {
      continue;
    } else if (path && (raw.startsWith("+") || raw.startsWith(" "))) {
      header = false;
      const line = raw.slice(1);
      const found = TOML.test(path) ? HEADER.exec(line.trim()) : null;
      if (found) section = found[1];
      if (raw.startsWith("+")) added.push({ path, line, ...(section && TOML.test(path) ? { section } : {}) });
    }
  }
  return added;
}

/** The removed lines of a unified diff, with their file (the header block is read as in `addedLinesOf`). */
export function removedLinesOf(diff: string): AddedLine[] {
  const removed: AddedLine[] = [];
  let path = "";
  let header = false;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      header = true;
      path = "";
    } else if (header && raw.startsWith("--- ")) {
      path = raw.slice(4).replace(/^a\//, "");
    } else if (raw.startsWith("@@")) {
      header = false;
    } else if (header && HEADER_LINE.test(raw)) {
      continue;
    } else if (path && raw.startsWith("-")) {
      header = false;
      removed.push({ path, line: raw.slice(1) });
    }
  }
  return removed;
}

const SWITCHED_OFF = /\b(?:it|test|describe)\.(?:skip|only|skipIf|runIf|todo|fixme|fails)\b|\bx(?:it|describe|test)\(|@Ignore\b|@Disabled\b|\bt\.Skip(?:Now|f)?\(|#\[ignore\b|pytest\.mark\.(?:skip|skipif|xfail)|\bpytest\.skip\(|@unittest\.(?:skip|skipIf|skipUnless|expectedFailure)|\bthis\.skip\(/;
const ISSUE_CAP = 120;
const SCENARIO_TAG = /@scenario:([A-Za-z0-9_-]+)/g;

/** The changed paths of `git diff --name-status`: a rename or copy counts under its new path. */
function changedOf(nameStatus: string): string[] {
  return nameStatus
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      const [, ...paths] = line.split("\t");
      return paths.at(-1) ?? "";
    })
    .filter(Boolean);
}

/** A planned entry is read as a glob only with one of these: brackets, parentheses and `!` are ordinary in real paths (`app/[team]/page.tsx`). */
const GLOB = /[*?{]/;
function isPlanned(path: string, planned: string[]): boolean {
  return planned.some((entry) => {
    const bare = entry.replace(/^\.\//, "");
    if (bare === path) return true;
    if (GLOB.test(bare)) return picomatch.isMatch(path, bare, { dot: true });
    return path.startsWith(`${bare.replace(/\/$/, "")}/`);
  });
}

const base = (path: string) => path.slice(path.lastIndexOf("/") + 1);

function dependencyOf({ path, line, section }: AddedLine): string | null {
  const file = base(path);
  const text = line.trim();
  if (file === "package.json") {
    const m = /^"([^"]+)"\s*:\s*"([^"]+)"\s*,?$/.exec(text);
    if (!m || ["version", "node", "npm", "pnpm", "yarn"].includes(m[1]!)) return null;
    return /^([~^<>=]*\d|workspace:|npm:|latest$|\*$|git|file:|link:)/.test(m[2]!) ? `${path}: ${m[1]} ${m[2]}` : null;
  }
  if (file === "go.mod") {
    const m = /^(?:require\s+)?([\w.-]+\.[\w.-]+\/[\w./-]+)\s+(v\d\S*)/.exec(text);
    return m ? `${path}: ${m[1]} ${m[2]}` : null;
  }
  if (file === "Cargo.toml") {
    const m = /^([\w-]+)\s*=\s*("|\{)/.exec(text);
    return m && section?.endsWith("dependencies") ? `${path}: ${m[1]}` : null;
  }
  if (file === "pyproject.toml") {
    const m = /^"([A-Za-z0-9_.-]+(?:\[[^\]]*\])?\s*(?:[<>=!~;].*)?)"\s*,?$/.exec(text);
    return m && (section === undefined || /dependencies/.test(section)) && /^[A-Za-z]/.test(m[1]!) && !/^(name|version)\b/.test(m[1]!) ? `${path}: ${m[1]}` : null;
  }
  if (/^requirements.*\.txt$/.test(file)) {
    const m = /^([A-Za-z0-9_.-]+(?:\[[^\]]*\])?\s*(?:[<>=!~].*)?)$/.exec(text);
    return m && !text.startsWith("#") ? `${path}: ${m[1]}` : null;
  }
  return null;
}

export function scopeFacts(input: { nameStatus: string; addedLines: AddedLine[]; removedLines?: AddedLine[]; /** The tests the tests step committed, by scenario: the scope is measured from that commit, and any change to one of these files is a weakened test. */ scenarioTests?: readonly { scenario: string; file: string }[]; /** Every path of the tests commit (helpers and fixtures included): none may change without a person. */ protectedPaths?: readonly string[]; /** Source files that hold Rust's inline tests as well as production code: changing one is not a weakened test, losing a scenario tag from one is. */ inlineTests?: readonly string[]; planned: string[]; declared: { path: string; reason?: string }[];
  /** An approved plan exists: an empty planned list then switches nothing off (every changed file is undeclared). */
  planPresent?: boolean }): ScopeFacts {
  const changed = changedOf(input.nameStatus);
  const declared = new Set(input.declared.map((d) => d.path));
  const deleted = new Set(input.nameStatus.split("\n").filter((l) => l.startsWith("D\t")).map((l) => l.slice(2)));
  return {
    changed,
    undeclared: input.planned.length === 0 && input.planPresent !== true ? [] : changed.filter((p) => !isPlanned(p, input.planned) && !declared.has(p)),
    removedTests: lockedFilesRemoved(input.nameStatus),
    newDependencies: input.addedLines.flatMap((l) => dependencyOf(l) ?? []),
    todos: input.addedLines.filter((l) => /\b(TODO|FIXME|XXX)\b/.test(l.line)).map((l) => `${l.path}: ${l.line.trim()}`),
    secrets: [
      ...changed.filter((p) => !deleted.has(p) && SECRET_FILE.test(p)),
      ...input.addedLines.filter((l) => TOKEN.test(l.line)).map((l) => `${l.path}: ${TOKEN.exec(l.line)![0].slice(0, 4)}\u2026`),
    ],
    switchedOff: input.addedLines.filter((l) => SWITCHED_OFF.test(l.line)).map((l) => `${l.path}: ${l.line.trim()}`),
    weakened: weakenedOf(input.removedLines ?? [], input.addedLines, input.nameStatus, input.scenarioTests ?? [], input.protectedPaths ?? [], input.inlineTests ?? []),
  };
}

function weakenedOf(removed: AddedLine[], added: AddedLine[], nameStatus: string, scenarioTests: readonly { scenario: string; file: string }[], protectedPaths: readonly string[], inlineTests: readonly string[] = []): string[] {
  const tagsOf = (lines: AddedLine[]) => lines.flatMap((l) => [...l.line.matchAll(SCENARIO_TAG)].map((m) => m[1]!));
  // A tag counts as kept only on an added line of a test file: a tag re-added in production code keeps nothing.
  const kept = new Set(tagsOf(added.filter((l) => looksLikeTestPath(l.path))));
  const lost = tagsOf(removed).filter((id) => !kept.has(id));
  // The scenario tests are fixed once committed: any change to a file that holds one (a delete or a rename-away included), tag untouched or not.
  const touched = new Set(nameStatus.split("\n").filter((l) => l.trim()).flatMap((l) => l.split("\t").slice(1)));
  // A file that holds Rust's inline tests holds production code too: the implementer changes it, and the tag lost above is what shows a test was cut.
  const inline = new Set(inlineTests);
  const changed = scenarioTests.filter((t) => touched.has(t.file) && !inline.has(t.file)).map((t) => t.scenario);
  // Every other path of the tests commit is protected as well, named by its path.
  const mapped = new Set(scenarioTests.map((t) => t.file));
  const others = protectedPaths.filter((p) => touched.has(p) && !mapped.has(p)).map((p) => `file:${p}`);
  return [...new Set([...changed, ...lost, ...others])];
}

/** The facts as issues, each with a severity: a blocker for an undeclared file, a removed, switched-off or weakened test and a secret; should_fix for a dependency the plan did not name and an unrelated refactor the check judged; a nit for a TODO. `judged` names what scope_check's answers found beyond the facts.
 *  An issue's text is redacted by `safe()` and cut at 120 characters (an added line can hold anything), and carries the path apart so a message can say where in fixed words. Pure. */
export function scopeIssues(facts: ScopeFacts, judged: readonly string[]): ScopeIssue[] {
  const text = (value: string): string => safe(value).slice(0, ISSUE_CAP);
  const where = (entry: string): string => entry.split(": ")[0] ?? "";
  const issue = (severity: ScopeSeverity, kind: ScopeIssue["kind"], value: string, path?: string): ScopeIssue => ({ severity, kind, text: text(value), ...(path ? { path: text(path) } : {}) });
  return [
    ...facts.undeclared.map((p) => issue("blocker", "undeclared_file", `${p}: changed outside the plan and not declared`, p)),
    ...facts.removedTests.map((p) => issue("blocker", "test_removed", `${p}: test removed`, p)),
    ...facts.switchedOff.map((t) => issue("blocker", "switched_off_test", `test switched off: ${t}`, where(t))),
    ...facts.weakened.map((id) => (id.startsWith("file:") ? issue("blocker", "test_weakened", `${id.slice(5)}: a file of the tests commit was changed`, id.slice(5)) : issue("blocker", "test_weakened", `${id}: the scenario's tagged test was changed after the tests commit`))),
    ...facts.secrets.map((s) => issue("blocker", "secret", `secret-looking addition: ${s}`, where(s))),
    ...facts.newDependencies.map((d) => issue("should_fix", "new_dependency", `dependency the plan did not name: ${d}`, where(d))),
    ...(judged.includes("unrelated_refactor") ? [issue("should_fix", "unrelated_refactor", "an unrelated refactor rides in the change")] : []),
    ...facts.todos.map((t) => issue("nit", "todo", `TODO left in place: ${t}`, where(t))),
  ];
}

const FACT_CAP = 160;

/** The facts as they may be stored and shown to a model: each line an added line contributed (a TODO, a switched-off test, a dependency) redacted by `safe()` and cut. Paths are left as they are, for matching. */
export function sanitizeFacts(facts: ScopeFacts): ScopeFacts {
  const clean = (lines: string[]) => lines.map((l) => safe(l).slice(0, FACT_CAP));
  return { ...facts, todos: clean(facts.todos), switchedOff: clean(facts.switchedOff), newDependencies: clean(facts.newDependencies), secrets: clean(facts.secrets) };
}
