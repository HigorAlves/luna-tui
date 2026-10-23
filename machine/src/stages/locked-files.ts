// A file that looks like a test, modified or deleted (not added) in a diff, is treated
// as "locked": the implementer is asked not to edit tests directly (it should answer
// "test_change" instead), and this makes that an enforced check rather than a polite
// request in the prompt.
const TEST_PATH_PATTERN = /(^|\/)(__tests__\/|tests?\/|spec\/).*|(\.|_)(test|spec)\.[^./]+$|_test\.[^./]+$/i;

/** Parses `git diff --name-status <a> <b>` output and returns the paths of any existing
 *  test file that was modified or deleted (status M or D) — not newly added ones. */
export function lockedFilesTouched(diffNameStatus: string): string[] {
  const touched: string[] = [];
  for (const line of diffNameStatus.split("\n")) {
    if (!line.trim()) continue;
    const [status, ...pathParts] = line.split("\t");
    const path = pathParts.join("\t");
    if ((status === "M" || status === "D") && TEST_PATH_PATTERN.test(path)) touched.push(path);
  }
  return touched;
}
