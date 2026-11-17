// What the company brain did in a week, as the counts the weekly status report shows (RFC 0008 wave 7, RFC 0010). Numbers only: no claim's
// text reaches the report. Each number is read on its own, so a store or a graph that fails costs that one number, never the report.
import type { StatusReportContext } from "@hardness/contracts";

import type { Brain } from "./brain.ts";
import type { ClaimStore } from "./brain-claims.ts";

/** The store's own bound on a page: a week with more decisions than this by Jev alone counts this many. */
const PAGE = 200;

const zeroOnFailure = async <T>(read: () => Promise<T>, otherwise: T): Promise<T> => {
  try {
    return await read();
  } catch {
    return otherwise;
  }
};

export async function brainWeek(deps: { claims: Pick<ClaimStore, "list" | "stats">; brain: Brain; since: Date; until: Date }): Promise<NonNullable<StatusReportContext["brain"]>> {
  const { claims, brain, since, until } = deps;
  const decidedByJev = async (status: "verified" | "rejected") =>
    (await zeroOnFailure(() => claims.list({ status, decidedBy: "jev", decidedSince: since, limit: PAGE }), [])).filter((claim) => !claim.decidedAt || new Date(claim.decidedAt) <= until);
  const rows = async (query: string) => (brain.enabled ? zeroOnFailure(async () => (await brain.query(query)).rows.length, 0) : 0);
  const [verified, rejected, waiting, atRisk, contested] = await Promise.all([
    decidedByJev("verified"),
    decidedByJev("rejected"),
    zeroOnFailure(async () => (await claims.stats()).waiting, 0),
    rows("learnings_at_risk"),
    rows("contested_claims"),
  ]);
  return { verifiedByJev: verified.length, flagged: verified.filter((claim) => claim.proposed === "flag").length, rejectedByJev: rejected.length, waiting, atRisk, contested };
}
