// Commit anchoring (RFC 0007, "Forgetting"): an item written about some files was true at the commit it names. Once those files have
// moved on by more lines than `memory.stale_lines` (default 200) since that commit, the item is `stale`: recall still returns it,
// marked, and a person or a later run can forget it. Git facts come from the machine's own helper on the user's repository, by
// path (`linesChangedSince`), never from a card's workspace. The sweep is idempotent: it only moves `active` items to `stale`.
import type { MemoryItem } from "@hardness/contracts";

import type { Memory } from "./memory.ts";

export const DEFAULT_STALE_LINES = 200;

export interface AnchoringDeps {
  memory: Memory;
  /** The checkouts the machine knows. */
  repoPaths(): Promise<string[]>;
  /** A checkout path's repository slug (`repoSlug()`), the name items carry. */
  slugOf(repoPath: string): string;
  /** Lines changed in `files` between `commit` and the default branch; null when unknown. */
  linesChanged(repoPath: string, commit: string, files: readonly string[]): Promise<number | null>;
  /** The repository's `memory.stale_lines`; absent, the default. */
  staleLines?(repoPath: string): Promise<number | undefined>;
}

/** Whether an item has anchors at all: a commit and at least one file. An item about no file never goes stale this way. */
export const isAnchored = (item: MemoryItem): item is MemoryItem & { anchors: { commit: string; files: string[] } } => item.anchors.commit !== null && item.anchors.files.length > 0;

/** Whether an item's anchored files changed by more than `limit` lines since its commit; false when that cannot be told. */
export async function isStaleByAnchors(item: MemoryItem, repoPath: string, linesChanged: AnchoringDeps["linesChanged"], limit: number = DEFAULT_STALE_LINES): Promise<boolean> {
  if (!isAnchored(item)) return false;
  const lines = await linesChanged(repoPath, item.anchors.commit, item.anchors.files);
  return lines !== null && lines > limit;
}

/** Marks stale the active items whose anchored files moved past the limit; answers how many it looked at and how many it moved. */
export async function sweepStale(deps: AnchoringDeps): Promise<{ checked: number; staled: number }> {
  let checked = 0;
  let staled = 0;
  if (!deps.memory.enabled) return { checked, staled };
  for (const repoPath of await deps.repoPaths()) {
    const repo = deps.slugOf(repoPath);
    const limit = (await deps.staleLines?.(repoPath).catch(() => undefined)) ?? DEFAULT_STALE_LINES;
    const items = await deps.memory.list({ repo, status: ["active"], limit: 500 });
    for (const item of items.filter(isAnchored)) {
      checked += 1;
      const lines = await deps.linesChanged(repoPath, item.anchors.commit, item.anchors.files).catch(() => null);
      if (lines !== null && lines > limit) {
        await deps.memory.setStatus(item.id, "stale", `its anchored files changed ${lines} lines since ${item.anchors.commit.slice(0, 7)}`);
        staled += 1;
      }
    }
  }
  return { checked, staled };
}
