// The one rule for taking a card's workspace off disk once the card has ended: the close hook
// and the nightly sweep both go through it, so neither can drop work the other would keep.
import { resolve } from "node:path";

import { isClone, unpushedCommits } from "../adapters/git/clone.ts";
import { removeWorktree } from "../adapters/git/worktree.ts";

export type WorktreeRelease = { kind: "removed" } | { kind: "kept"; reason: string };

/** Why a workspace must stay, or null when it may go: it is the repository's own checkout, a card that is still open uses it, or it holds commits no remote has. */
export async function worktreeKeepReason(repoPath: string, worktreePath: string, openHolder?: string | null): Promise<string | null> {
  if (resolve(worktreePath) === resolve(repoPath)) return "it is the repository's own checkout, not a workspace of the machine";
  if (openHolder) return `the open card ${openHolder} uses the same folder`;
  if (isClone(worktreePath)) {
    const unpushed = await unpushedCommits(worktreePath);
    if (unpushed.length > 0) return `the clone holds ${unpushed.length} unpushed commit(s); push them, or remove it from the board`;
  }
  return null;
}

/** Removes the workspace unless a keep reason holds. Throws when the removal itself fails. */
export async function releaseWorktree(repoPath: string, worktreePath: string, openHolder?: string | null): Promise<WorktreeRelease> {
  const reason = await worktreeKeepReason(repoPath, worktreePath, openHolder);
  if (reason) return { kind: "kept", reason };
  await removeWorktree(repoPath, worktreePath);
  return { kind: "removed" };
}
