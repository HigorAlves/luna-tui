// Whether the repository itself requires a review before a PR merges, and whether a review that counts is on the head. Pure scripts over
// GitHub's facts; nothing a PR comment, a review body or a model says reaches them. An unreadable rule is not a rule: it means manual.
import { type CodeownersRule, requiredOwners } from "./codeowners.ts";

/** What the repository's own rules say about the base branch (the GitHub port reads them). */
export type ReviewRule =
  | { source: "ruleset" | "branch_protection"; approvals: number; codeOwners: boolean }
  | { source: "none" }
  | { source: "unreadable"; why: string };

export type ReviewRequirement = { required: true; by: string } | { required: false } | { required: null; why: string };

/** A review is required when a ruleset or protection asks for an approval or a code owner's review, when GitHub itself said REVIEW_REQUIRED for this PR,
 *  or when a CODEOWNERS file at the base ref names an owner for every changed path (one unowned path does not count). Unreadable with none of the others: null. */
export function reviewRequirement(input: { rule: ReviewRule; seenRequired: boolean; owners: CodeownersRule[] | null; paths: string[] }): ReviewRequirement {
  const { rule, seenRequired, owners, paths } = input;
  if ((rule.source === "ruleset" || rule.source === "branch_protection") && (rule.approvals >= 1 || rule.codeOwners)) return { required: true, by: rule.source === "ruleset" ? "a ruleset" : "branch protection" };
  if (seenRequired) return { required: true, by: "GitHub's own review requirement for this PR" };
  if (owners && paths.length > 0 && requiredOwners(paths, owners).length === paths.length) return { required: true, by: "CODEOWNERS" };
  if (rule.source === "unreadable") return { required: null, why: rule.why };
  return { required: false };
}

/** Only these author associations are the repository's own people. */
const TRUSTED = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

export interface ReviewOf {
  author: string | null;
  state: string;
  commitId: string | null;
  association?: string | null;
}

/** The logins whose approval counts: each one's latest verdict is APPROVED, given on the head commit, by an owner, member or collaborator who is not the token's own login. Oldest first. */
export function approversOnHead(reviews: ReviewOf[], head: string | null, me: string | null): string[] {
  if (head === null || me === null) return [];
  const latest = new Map<string, ReviewOf>();
  for (const r of reviews) if (r.author && (r.state === "APPROVED" || r.state === "CHANGES_REQUESTED" || r.state === "DISMISSED")) latest.set(r.author.toLowerCase(), r);
  return [...latest.values()].filter((r) => r.state === "APPROVED" && r.commitId === head && TRUSTED.has(r.association ?? "") && r.author!.toLowerCase() !== me.toLowerCase()).map((r) => r.author!);
}

/** An approval counts only when it is its author's latest verdict, given on the head commit, by an owner, member or collaborator who is not the token's own login. */
export function approvedOnHead(reviews: ReviewOf[], head: string | null, me: string | null): boolean {
  return approversOnHead(reviews, head, me).length > 0;
}

/** The one body that counts as a release approval in a PR comment: `/ship`, nothing else, in any case. The machine opens PRs under the token's own login, and GitHub never
 *  lets a PR's author approve it, so this comment is how that login's person says it. The machine never posts this body (`refuseShipCommand`), so no comment of its own matches. */
export const isShipCommand = (body: string): boolean => body.trim().toLowerCase() === "/ship";

export interface CommentOf {
  kind: string;
  actor: string | null;
  isBot: boolean;
  association: string | null;
  body: string;
  at: string;
}

/** The logins whose `/ship` comment counts: a conversation comment made after `after` (ms; the head commit's time, or later), by an owner, member or collaborator. The
 *  token's own login is allowed here, unlike a review: its comment is the person's, and a comment of the machine's own cannot be `/ship`. Oldest first, once each.
 *  An unknown cutoff counts nothing (fail closed). */
export function approversByComment(comments: CommentOf[], after: number | null): string[] {
  if (after === null || !Number.isFinite(after)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of [...comments].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) {
    const at = Date.parse(c.at);
    if (c.kind !== "comment" || c.isBot || !c.actor || !isShipCommand(c.body) || !TRUSTED.has(c.association ?? "") || !Number.isFinite(at) || at <= after) continue;
    if (seen.has(c.actor.toLowerCase())) continue;
    seen.add(c.actor.toLowerCase());
    out.push(c.actor);
  }
  return out;
}

/** The login of an owner, member or collaborator (not the token's own login) whose latest verdict on the PR is "changes requested"; null when there is none. */
export function objectionOnPr(reviews: ReviewOf[], me: string | null): string | null {
  const latest = new Map<string, ReviewOf>();
  for (const r of reviews) if (r.author && (r.state === "APPROVED" || r.state === "CHANGES_REQUESTED" || r.state === "DISMISSED")) latest.set(r.author.toLowerCase(), r);
  for (const r of latest.values()) if (r.state === "CHANGES_REQUESTED" && TRUSTED.has(r.association ?? "") && r.author!.toLowerCase() !== (me ?? "").toLowerCase()) return r.author;
  return null;
}
