// Rows of the company brain for a claim (RFC 0010, "Remember"): the source it was made in, the claim and, once a verified claim is
// durable, the lesson that rests on it. Pure. A refused claim never reaches the graph, and an edge is only given to a node the
// graph holds or this load carries, since the server refuses an edge to a node it does not have.
import { brainEdge, brainNode, brainSlug, brainTime, type BrainClaim, type BrainRow } from "@hardness/contracts";

import { flatTitle, repoRows, type BrainRepo } from "./rows.ts";
import { personRows } from "./rows-people.ts";

export function claimRows(
  claim: BrainClaim,
  context: {
    repo: BrainRepo | null;
    /** The card of a `card` source is in the graph. */
    hasCard: boolean;
    /** Another claim is in the graph or in this load. */
    knows: (claimId: string) => boolean;
  },
): BrainRow[] {
  if (claim.status === "refused") return [];
  const { repo } = context;
  const rows: BrainRow[] = [];
  if (repo) rows.push(...repoRows(repo));

  const isCard = claim.source.kind === "card";
  const source = brainSlug("source", isCard ? `card/${claim.source.ref}` : `note/${claim.id}`);
  rows.push(brainNode("Source", { slug: source, kind: isCard ? "card" : "note", title: isCard ? flatTitle(claim.source.title) : "A note", occurred_at: brainTime(claim.createdAt) }));
  if (isCard && context.hasCard) rows.push(brainEdge("SourceOfCard", source, brainSlug("card", claim.source.ref)));

  const speaker = claim.speaker?.trim() ? claim.speaker : null;
  if (speaker) rows.push(...personRows({ login: speaker }));

  const slug = brainSlug("claim", claim.id);
  rows.push(
    brainNode("Claim", {
      slug,
      statement: claim.statement,
      quote: claim.quote,
      kind: claim.kind,
      scope: claim.scope,
      status: claim.status,
      risk: claim.tier,
      decided_by: claim.decidedBy,
      recorded_at: brainTime(claim.createdAt),
      decided_at: claim.decidedAt ? brainTime(claim.decidedAt) : null,
    }),
    brainEdge("ClaimFrom", slug, source),
  );
  if (repo) rows.push(brainEdge("ClaimAboutRepo", slug, brainSlug("repo", repo.slug)));
  if (speaker) rows.push(brainEdge("ClaimedBy", slug, brainSlug("person", speaker.trim().toLowerCase())));
  for (const other of claim.contradicts) if (context.knows(other)) rows.push(brainEdge("Contradicts", slug, brainSlug("claim", other)));

  if (claim.status === "verified" && claim.durable === true) {
    const learning = brainSlug("learning", claim.id);
    rows.push(
      brainNode("Learning", { slug: learning, title: claim.statement, kind: claim.kind, scope: claim.scope, recorded_at: brainTime(claim.decidedAt ?? claim.createdAt) }),
      brainEdge("BasedOn", learning, slug),
    );
    if (repo) rows.push(brainEdge("LearningAboutRepo", learning, brainSlug("repo", repo.slug)));
  }
  return rows;
}
