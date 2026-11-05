// The tests step's diff, checked by script: every approved scenario has a tagged test on an added line of a test file, the step touches only
// test files and fixtures beside them, and no test file is removed. The tag is `@scenario:<id>` in a test's name or in the comment above it. Pure.
import { addedLinesOf } from "./scope.ts";
import { looksLikeTestPath } from "./locked-files.ts";

export interface ScenarioTagFacts {
  ok: boolean;
  /** Scenario ids with no tagged test. */
  missing: string[];
  /** Scenario id to the first test file that carries its tag. */
  tagged: Record<string, string>;
  /** Changed files that are neither test files nor fixtures beside them. */
  nonTest: string[];
  /** Test files the step removed or renamed away. */
  removed: string[];
}

const FIXTURE_DIR = /(^|\/)(__fixtures__|__snapshots__|fixtures?|testdata|__mocks__|mocks?)\//i;
const TAG = /@scenario:([A-Za-z0-9_-]+)/g;

export function scenarioTags(input: { nameStatus: string; diff: string; scenarios: readonly { id?: string }[]; testFiles?: readonly string[] }): ScenarioTagFacts {
  const mapTests = new Set(input.testFiles ?? []);
  const isTest = (path: string) => mapTests.has(path) || looksLikeTestPath(path);
  const rows = input.nameStatus.split("\n").filter((l) => l.trim()).map((l) => l.split("\t"));
  const nonTest: string[] = [];
  const removed: string[] = [];
  for (const [status = "", ...paths] of rows) {
    const path = paths[paths.length - 1] ?? "";
    if (/^[DRC]/.test(status) && paths[0] && isTest(paths[0]) && !status.startsWith("C")) removed.push(paths[0]);
    if (status.startsWith("D")) continue;
    if (!isTest(path) && !FIXTURE_DIR.test(path)) nonTest.push(path);
  }
  const tagged: Record<string, string> = {};
  for (const added of addedLinesOf(input.diff)) {
    if (!isTest(added.path)) continue;
    for (const match of added.line.matchAll(TAG)) tagged[match[1]!] ??= added.path;
  }
  const ids = input.scenarios.flatMap((s) => (s.id ? [s.id] : []));
  const missing = ids.filter((id) => !(id in tagged));
  return { ok: missing.length === 0 && nonTest.length === 0 && removed.length === 0, missing, tagged: Object.fromEntries(ids.filter((id) => id in tagged).map((id) => [id, tagged[id]!])), nonTest, removed };
}
