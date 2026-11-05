// The tests step's diff, checked by script: every approved scenario has a tagged test on an added line of a test file, the step touches only
// test files and fixtures beside them, and no test file is removed. The tag is `@scenario:<id>` in a test's name or in the comment above it, one
// per line. The writer can run any code in its container, so nothing here trusts it: a deleted or renamed-away file, a control-plane path, a
// symlink or a nested repository is never a test. Pure.
import { addedLinesOf } from "./scope.ts";
import { inTestDir, looksLikeTestPath } from "./locked-files.ts";
import { isControlPlane } from "./control-plane.ts";

export interface ScenarioTagFacts {
  ok: boolean;
  /** Scenario ids with no tagged test. */
  missing: string[];
  /** Scenario id to the first test file that carries its tag. */
  tagged: Record<string, string>;
  /** Changed files that are neither test files nor fixtures beside them (a deleted or renamed-away one counts by its old path). */
  nonTest: string[];
  /** Test files the step removed or renamed away. */
  removed: string[];
  /** Test files with an added line that carries several scenario ids: sent back, no scenario is credited by it. */
  ambiguous: string[];
}

const FIXTURE_DIR = /(^|\/)(__fixtures__|__snapshots__|fixtures?|testdata|__mocks__|mocks?)\//i;
const SOURCE_EXT = /\.(?:[cm]?[jt]sx?|py|go|rs|rb|java|kt|swift|cs|php)$/i;
const TAG = /@scenario:([A-Za-z0-9_-]+)/g;
const BARE_TEST = /(^|\/)(test|spec)\.[^./]+$/i;
const SYMLINK = "120000";
const GITLINK = "160000";

/** A control-plane path at any depth: `.github/` or `CODEOWNERS` under a fixture folder is as much the control plane as at the root. */
function controlPlaneAnywhere(path: string): boolean {
  const parts = path.split("/");
  return parts.some((_, i) => isControlPlane(parts.slice(i).join("/")));
}

export function scenarioTags(input: { nameStatus: string; diff: string; scenarios: readonly { id?: string }[]; testFiles?: readonly string[]; /** The new mode of each added or changed path (`git diff --raw`); a symlink or a gitlink is never a test. */ modes?: Readonly<Record<string, string>> }): ScenarioTagFacts {
  const mapTests = new Set(input.testFiles ?? []);
  const modes = input.modes ?? {};
  const plain = (path: string) => !controlPlaneAnywhere(path) && modes[path] !== SYMLINK && modes[path] !== GITLINK;
  // A bare `test.<ext>` or `spec.<ext>` is a test only inside a test directory; any other test-named file needs a source extension.
  const isTest = (path: string) => plain(path) && (mapTests.has(path) || (looksLikeTestPath(path) && SOURCE_EXT.test(path) && (!BARE_TEST.test(path) || inTestDir(path))));
  const tagged: Record<string, string> = {};
  const ambiguous: string[] = [];
  for (const added of addedLinesOf(input.diff)) {
    if (!isTest(added.path)) continue;
    const ids = [...new Set([...added.line.matchAll(TAG)].map((m) => m[1]!))];
    if (ids.length > 1) {
      if (!ambiguous.includes(added.path)) ambiguous.push(added.path);
    } else if (ids.length === 1) {
      tagged[ids[0]!] ??= added.path;
    }
  }
  const taggedDirs = [...new Set(Object.values(tagged).map((p) => p.split("/").slice(0, -1).join("/")))];
  // A fixture is taken only as an added file under a test directory or beside a tagged test; a modified or deleted one elsewhere (a mock production imports) is a production change.
  const fixtureOk = (path: string, status: string) => {
    if (!plain(path) || !FIXTURE_DIR.test(path)) return false;
    if (inTestDir(path)) return true;
    if (!status.startsWith("A")) return false;
    const home = path.slice(0, FIXTURE_DIR.exec(path)!.index).replace(/\/$/, "");
    return taggedDirs.some((d) => (home === "" ? d === "" : d === home || d.startsWith(`${home}/`)));
  };
  const rows = input.nameStatus.split("\n").filter((l) => l.trim()).map((l) => l.split("\t"));
  const nonTest: string[] = [];
  const removed: string[] = [];
  const flag = (path: string) => {
    if (path && !nonTest.includes(path)) nonTest.push(path);
  };
  for (const [status = "", ...paths] of rows) {
    const path = paths[paths.length - 1] ?? "";
    const old = paths[0] ?? "";
    if (/^[DR]/.test(status)) {
      // What goes away is judged by its old path: deleting or renaming production code away is a production change.
      if (isTest(old)) removed.push(old);
      else if (!fixtureOk(old, "D")) flag(old);
    }
    if (status.startsWith("D")) continue;
    if (!isTest(path) && !fixtureOk(path, status)) flag(path);
  }
  const ids = input.scenarios.flatMap((s) => (s.id ? [s.id] : []));
  const missing = ids.filter((id) => !(id in tagged));
  return {
    ok: missing.length === 0 && nonTest.length === 0 && removed.length === 0 && ambiguous.length === 0,
    missing,
    tagged: Object.fromEntries(ids.filter((id) => id in tagged).map((id) => [id, tagged[id]!])),
    nonTest,
    removed,
    ambiguous,
  };
}
