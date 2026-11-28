// What changed in the PR inbox between two polls, and one line of what waits on you: what a client
// says out loud (Luna's buddy, a notice). The machine notices; a client decides when to say it.
// Pure: two snapshots in, the activity out. Ported from Luna's GitHubActivity.
import type { PrActivity, PrActivityKind, PrSnapshot, PullRequest } from "@hardness/contracts";

const key = (pr: PullRequest): string => `${pr.repo.toLowerCase()}#${pr.number}`;

/** Asked of you and not your own: a team you are in being asked to review your PR is no ask of you. */
const asksYourReview = (pr: PullRequest): boolean => pr.split === "review_requested";

/**
 * What changed from `before` to `after`, stamped `at`. The first poll (`before` never polled) has
 * nothing to compare with: the digest sums it up instead of one line per open PR. A PR first seen
 * now raises only a review asked of you; the rest need a before to change from.
 */
export function activityOf(before: PrSnapshot, after: PrSnapshot, at: string): PrActivity[] {
  if (before.polledAt === null) return [];
  const was = new Map(before.prs.map((pr) => [key(pr), pr]));
  const out: PrActivity[] = [];
  const say = (kind: PrActivityKind, pr: PullRequest) => out.push({ kind, repo: pr.repo, number: pr.number, title: pr.title, url: pr.url, at });
  for (const pr of after.prs) {
    const then = was.get(key(pr));
    if (asksYourReview(pr) && !(then && asksYourReview(then))) say("review_requested", pr);
    if (!then || !pr.mine) continue;
    const ready = pr.split === "ready_to_merge";
    if (pr.checks.state === "failure" && then.checks.state !== "failure") say("checks_failed", pr);
    else if (pr.checks.state === "success" && then.checks.state === "failure" && !ready) say("checks_passed", pr);
    if (ready && then.split !== "ready_to_merge") say("ready_to_merge", pr);
    if (pr.reviewDecision === "CHANGES_REQUESTED" && then.reviewDecision !== "CHANGES_REQUESTED") say("changes_requested", pr);
  }
  return out;
}

/** One line of what waits on you; null when nothing does. */
export function digestOf(snapshot: PrSnapshot): string | null {
  const reviews = snapshot.prs.filter(asksYourReview).length;
  const failing = snapshot.prs.filter((pr) => pr.mine && pr.checks.state === "failure").length;
  const ready = snapshot.prs.filter((pr) => pr.mine && pr.split === "ready_to_merge").length;
  const parts: string[] = [];
  if (reviews > 0) parts.push(reviews === 1 ? "1 PR is waiting for your review" : `${reviews} PRs are waiting for your review`);
  if (failing > 0) parts.push(failing === 1 ? "1 of your PRs has failing checks" : `${failing} of your PRs have failing checks`);
  if (ready > 0) parts.push(ready === 1 ? "1 is ready to merge" : `${ready} are ready to merge`);
  return parts.length > 0 ? parts.join(" · ") : null;
}
