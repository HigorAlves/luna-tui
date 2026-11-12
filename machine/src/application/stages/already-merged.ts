// A card whose own PR a person merged while the card was outside the ship watch (back in Verify after a merge round, re-planned, an
// escalation they resumed). Delivering and CI must not replay its commits against the squash of that PR: the card shipped, and it
// goes the way a merge the watch saw goes (`ship.merged`, then the retro). The PR numbers come from what the machine recorded, never
// from the ship cursor, which Evidence overwrites with the newest PR.
import type { GitHub } from "../github.ts";
import type { StageResult } from "../ports.ts";

/** The result of a stage that finds one of the card's PRs merged into the default branch, or null when none is (or GitHub cannot say: the stage goes on as it did). */
export async function alreadyMerged(
  github: Pick<GitHub, "prMerged" | "prFacts">,
  slug: string,
  recordedPrs: readonly number[] | undefined,
  defaultBranch: () => Promise<string | null>,
): Promise<StageResult | null> {
  // Newest first: the PR the card is on now is the one most likely to have merged.
  for (const number of [...new Set(recordedPrs ?? [])].reverse()) {
    const state = await github.prMerged(slug, number).catch(() => null);
    if (!state?.merged) continue;
    // Merged into another branch (a stacked card's parent, a retarget) is not a ship, whoever merged it. Unknown means not a ship.
    const base = (await github.prFacts(slug, number).catch(() => null))?.baseRefName ?? null;
    if (base !== null && base !== (await defaultBranch().catch(() => null))) continue;
    return { outcome: "pass", detail: { merged: { sha: state.mergedSha, at: state.mergedAt, by: "person" }, prUrl: `https://github.com/${slug}/pull/${number}`, number, alreadyMerged: true } };
  }
  return null;
}
