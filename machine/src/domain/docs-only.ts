// A plan that only rewrites documentation has nothing to test first: no behaviour is missing before the change, so a failing test for prose
// is a test of the prose itself (sentence counts over a README, a git diff against a fixed commit), written before the words and then
// locked against the very rewrite it measures. Build runs such a plan without its tests step: the implementer rewrites, writes any test
// the plan names itself, and Verify judges the scenarios and runs the repo's checks. Pure.
import { looksLikeTestPath } from "./locked-files.ts";

const DOC = /(\.(md|mdx|markdown|rst|adoc|txt)$)|(^|\/)(docs?|documentation)\//i;

/** Whether every path the plan touches is documentation or a test, and at least one is documentation. */
export function isDocsOnly(touchpoints: readonly string[]): boolean {
  const paths = touchpoints.map((p) => p.trim()).filter(Boolean);
  if (!paths.some((p) => DOC.test(p))) return false;
  return paths.every((p) => DOC.test(p) || looksLikeTestPath(p));
}
