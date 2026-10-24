// Shared by test/thing.test.js (which reads/writes the counter) and
// machine/scripts/golden-retry.mjs (which deletes it during cleanup) — one formula, so the
// two can't silently drift apart and leave stale `.count` files in the OS temp dir.
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The external counter file for a given test directory's absolute path, sanitized into a
 *  stable, valid filename unique per worktree. */
export function counterFilePath(testDirPath) {
  return join(tmpdir(), `hardness-flaky-${testDirPath.replace(/[^a-zA-Z0-9]/g, "_")}.count`);
}
