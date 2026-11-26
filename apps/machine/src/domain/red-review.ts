// What the test writer is told when red_check rejects a test. The judge's bare words ("it asserts its own setup") sent DISC-53's writer back
// with nothing to change: it rewrote none of the flagged tests. A line names the scenario's outcome to assert, or the fixture to write. Pure.

export const RIGHT_REASON_PROBLEM = "the test fails for a reason other than the missing behaviour (a typo, an import, a path or a fixture)";
export const NOT_TAUTOLOGICAL_PROBLEM = "the test would still pass without the behaviour: it asserts its own setup (a scenario that already holds before the change goes in holdsToday, with its reason, and gets no test)";

const MISSING_FIXTURE = /\bfixtures?\b[^\n]*\b(?:exist|missing|not found|ENOENT)|ENOENT[^\n]*__fixtures__/i;

/** One review line for a rejected scenario: `<id>: <what to change>`. */
export function redReviewLine(scenario: { id: string; title: string; then?: string | null }, problem: string, output?: string): string {
  const outcome = (scenario.then ?? "").trim() || scenario.title;
  if (problem === NOT_TAUTOLOGICAL_PROBLEM) {
    return `${scenario.id}: the test would still pass without the behaviour. Rewrite it to assert this outcome itself: "${outcome}". A status code, a type or a shape check is not that outcome; compare the actual values (which rows, which keys, what changed). Only a scenario that already holds on the default branch goes in holdsToday.`;
  }
  if (problem === RIGHT_REASON_PROBLEM && output && MISSING_FIXTURE.test(output)) {
    return `${scenario.id}: the test fails because a fixture it reads is missing, not because the behaviour is. A fixture is the test's input: write it in this step, beside the test.`;
  }
  return `${scenario.id}: ${problem}`;
}
