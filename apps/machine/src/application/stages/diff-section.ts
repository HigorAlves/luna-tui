// One file's section of a unified diff: what a finding's file looked like in the PR's diff when the worktree cannot show it, and what a thread's file gained since a review.

import type { Finding } from "@hardness/contracts";

/** The file's own section of the diff, capped. */
const DIFF_EXCERPT_CAP = 2000;
export function diffExcerptOf(diff: string, finding: Pick<Finding, "path">): string {
  const sections = diff.split(/^(?=diff --git )/m);
  const section = sections.find((part) => part.startsWith(`diff --git a/${finding.path} `) || part.split("\n", 1)[0]!.endsWith(` b/${finding.path}`));
  return (section ?? "").slice(0, DIFF_EXCERPT_CAP);
}

