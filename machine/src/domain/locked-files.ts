// A file that looks like a test, modified or deleted (not added) in a diff, is treated
// as "locked": the implementer is asked not to edit tests directly (it should answer
// "test_change" instead), and this makes that an enforced check rather than a polite
// request in the prompt.
const TEST_DIR_PATTERN = /(^|\/)(__tests__|tests?|spec)\//i;
// Matched against the basename only: "test"/"spec" as a prefix (test_cart.py, test.js),
// or set off by a dot/underscore anywhere, with the extension allowed to have further dots
// after it (cart.test.ts.snap) — not just a single bare extension — so a snapshot file next
// to a locked test isn't missed just because its own suffix has more than one segment.
const TEST_NAME_PATTERN = /^(test|spec)[._]|[._](test|spec)([._]|$)/i;

function looksLikeTestPath(path: string): boolean {
  if (TEST_DIR_PATTERN.test(path)) return true;
  const base = path.slice(path.lastIndexOf("/") + 1);
  return TEST_NAME_PATTERN.test(base);
}

/** Parses `git diff --name-status <a> <b>` output and returns the paths of any existing
 *  test file that was modified or deleted (status M or D) — not newly added ones.
 *
 *  A rename or copy (status `R100`, `C100`, ...) carries two tab-separated paths (old, new)
 *  rather than one, and its bare letter is never exactly "M" or "D" — without special-casing
 *  it, renaming a locked test file out from under it would silently skip the check entirely. */
export function lockedFilesTouched(diffNameStatus: string): string[] {
  const touched: string[] = [];
  for (const line of diffNameStatus.split("\n")) {
    if (!line.trim()) continue;
    const [status = "", ...pathParts] = line.split("\t");
    if (status.startsWith("R") || status.startsWith("C")) {
      // The old path is effectively removed (or replaced) by the rename/copy — treat it
      // like a delete for lock-checking purposes, regardless of what the new path is.
      const oldPath = pathParts[0] ?? "";
      if (looksLikeTestPath(oldPath)) touched.push(oldPath);
      continue;
    }
    const path = pathParts.join("\t");
    if ((status === "M" || status === "D") && looksLikeTestPath(path)) touched.push(path);
  }
  return touched;
}

/** The subset of lockedFilesTouched that was deleted or renamed away (status D, R, C): a
 *  change no replay can vindicate, since the file's tests are simply gone from HEAD. */
export function lockedFilesRemoved(diffNameStatus: string): string[] {
  const removed: string[] = [];
  for (const line of diffNameStatus.split("\n")) {
    if (!line.trim()) continue;
    const [status = "", ...pathParts] = line.split("\t");
    const path = status.startsWith("R") || status.startsWith("C") ? (pathParts[0] ?? "") : pathParts.join("\t");
    if ((status === "D" || status.startsWith("R") || status.startsWith("C")) && looksLikeTestPath(path)) removed.push(path);
  }
  return removed;
}
