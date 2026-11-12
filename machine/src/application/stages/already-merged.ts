// A card whose own PR a person merged while the card was outside the ship watch (back in Verify after a merge round, re-planned, an
// escalation they resumed). Delivering and CI must not replay its commits against the squash of that PR: the card shipped, and it
// goes the way a merge the watch saw goes (`ship.merged`, then the retro). The PR numbers come from what the machine recorded, never
// from the ship cursor, which Evidence overwrites with the newest PR.
//
// One exception: commits the card made after that PR merged are not in it. `followUp` looks for them; when it has something to say
// (a new PR for them, or a person to ask) that is the stage's result and the card did not ship.
import type { GitHub } from "../github.ts";
import type { StageResult } from "../ports.ts";

export interface MergedPr {
  number: number;
  sha: string | null;
  /** The branch the PR merged into, as GitHub says; the default branch when GitHub did not say. Null when neither is known. */
  base: string | null;
}

export interface FollowUpOptions {
  /** The card's branch: an open PR on it that is newer than the merged one means the card has moved on to that PR. */
  branch?: string;
  /** What to do about commits made after the merge; null when there are none (or it cannot tell), and the card shipped. */
  followUp?: (merged: MergedPr) => Promise<StageResult | null>;
}

/** The result of a stage that finds one of the card's PRs merged into the default branch, or null when none is (or GitHub cannot say: the stage goes on as it did). */
export async function alreadyMerged(
  github: Pick<GitHub, "prMerged" | "prFacts"> & Partial<Pick<GitHub, "findPr">>,
  slug: string,
  recordedPrs: readonly number[] | undefined,
  defaultBranch: () => Promise<string | null>,
  options: FollowUpOptions = {},
): Promise<StageResult | null> {
  // Newest first: the PR the card is on now is the one most likely to have merged.
  for (const number of [...new Set(recordedPrs ?? [])].reverse()) {
    const state = await github.prMerged(slug, number).catch(() => null);
    if (!state?.merged) continue;
    // Merged into another branch (a stacked card's parent, a retarget) is not a ship, whoever merged it. Unknown means not a ship.
    const base = (await github.prFacts(slug, number).catch(() => null))?.baseRefName ?? null;
    const dflt = await defaultBranch().catch(() => null);
    if (base !== null && base !== dflt) continue;
    // A follow-up PR of the card is open on its branch: the card is on that one, and this merge is already accounted for.
    if (options.branch && github.findPr) {
      const open = await github.findPr(slug, options.branch).catch(() => null);
      if (open && open.number > number) continue;
    }
    const followed = options.followUp ? await options.followUp({ number, sha: state.mergedSha, base: base ?? dflt }) : null;
    if (followed) return followed;
    return { outcome: "pass", detail: { merged: { sha: state.mergedSha, at: state.mergedAt, by: "person" }, prUrl: `https://github.com/${slug}/pull/${number}`, number, alreadyMerged: true } };
  }
  return null;
}
