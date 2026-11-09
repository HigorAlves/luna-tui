// What a merged pull request says it reverts (RFC 0007, "Forgetting"): GitHub's own revert convention. A revert PR made from
// the UI has the body `Reverts owner/name#123`, and its commit says `This reverts commit <sha>.` (what `git revert` writes
// too). The title alone (`Revert "..."`) names nothing the machine could look up, so it makes no target. Pure.

export interface RevertTargets {
  /** The PRs it reverts: `repo` is `owner/name`, or null for the PR's own repository. */
  prs: Array<{ repo: string | null; number: number }>;
  /** The commits it reverts, as written (7 to 40 hex digits, lowercase). */
  shas: string[];
}

const MAX_TARGETS = 5;

/** The PRs and commits a merged PR reverts; empty for a PR that reverts nothing it names. */
export function revertTargets(pr: { title: string; body: string | null }): RevertTargets {
  const text = `${pr.title}\n${pr.body ?? ""}`;
  const prs: RevertTargets["prs"] = [];
  for (const m of text.matchAll(/^\s*Reverts\s+(?:([\w.-]+\/[\w.-]+))?#(\d+)\b/gim)) {
    const found = { repo: m[1]?.toLowerCase() ?? null, number: Number(m[2]) };
    if (!prs.some((p) => p.repo === found.repo && p.number === found.number)) prs.push(found);
  }
  const shas = [...new Set([...text.matchAll(/\bThis reverts commit ([0-9a-f]{7,40})\b/gi)].map((m) => m[1]!.toLowerCase()))];
  return { prs: prs.slice(0, MAX_TARGETS), shas: shas.slice(0, MAX_TARGETS) };
}

export const revertsNothing = (targets: RevertTargets): boolean => targets.prs.length === 0 && targets.shas.length === 0;
