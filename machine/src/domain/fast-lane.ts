// The fast lane, a rule the machine checks and never the agent's own word: low risk, small, not infra or data, one owning
// team (or none), and the risk and size signals sure enough to act on. Pure.
import type { FactoryConfig, TriageRecord } from "@hardness/contracts";

import type { RequiredOwners } from "./codeowners.ts";
import type { FieldVerdict, TriageField } from "./triage-policy.ts";

const RISK = ["low", "medium", "high"] as const;
const SIZE = ["XS", "S", "M", "L", "XL"] as const;

/** What `locate` said about the owners, as the rule reads it: one team (or none), several, or not checked at all, with why. */
export type OwnersCheck = { owners: "one_team" } | { owners: "cross_team"; teams: number } | { owners: "not_checked"; reason: string };

/** What `locate` answered, for `ownersCheck`: null when the repo has no graph, "failed" when the call threw. */
export type Located = { files: string[]; owners: RequiredOwners[]; stale: boolean; behind: number | null; codeowners: boolean } | null | "failed";

/** The owning-team condition from the graph's answer. A condition that could not be checked is `not_checked`, never a pass:
 *  no graph, a failed call, a stale graph, no file matched the card's words, no CODEOWNERS. */
export function ownersCheck(located: Located): OwnersCheck {
  if (located === null) return { owners: "not_checked", reason: "no code graph" };
  if (located === "failed") return { owners: "not_checked", reason: "the code graph could not be asked" };
  if (located.stale) return { owners: "not_checked", reason: `the code graph is stale${located.behind === null ? "" : ` (${located.behind} commits behind)`}` };
  if (located.files.length === 0) return { owners: "not_checked", reason: "no file matched the card's words" };
  if (!located.codeowners) return { owners: "not_checked", reason: "the repository has no CODEOWNERS" };
  const teams = new Set(located.owners.flatMap((o) => o.owners)).size;
  return teams > 1 ? { owners: "cross_team", teams } : { owners: "one_team" };
}

/** `fast: true` with `ownersNotChecked` keeps the lane and says why the owners were not looked at: the plan gate lists it. */
export type FastLane = { fast: true; ownersNotChecked?: string } | { fast: false; failing: string };

export function fastLane(
  record: Partial<Pick<TriageRecord, "riskPrelim" | "size" | "typeOfWork">>,
  owners: OwnersCheck,
  config: FactoryConfig["fast_lane"],
  verdicts?: Partial<Record<TriageField, Pick<FieldVerdict, "verdict">>>,
): FastLane {
  const risk = RISK.indexOf(record.riskPrelim as (typeof RISK)[number]);
  if (risk < 0 || risk > RISK.indexOf(config.max_risk)) return { fast: false, failing: `preliminary risk is ${record.riskPrelim ?? "unknown"}, above ${config.max_risk}` };
  const size = SIZE.indexOf(record.size as (typeof SIZE)[number]);
  if (size < 0 || size > SIZE.indexOf(config.max_size)) return { fast: false, failing: `size is ${record.size ?? "unknown"}, above ${config.max_size}` };
  if (!record.typeOfWork || config.excluded_types.includes(record.typeOfWork)) return { fast: false, failing: `type of work ${record.typeOfWork ?? "unknown"} is not for the fast lane` };
  if (verdicts && (verdicts.risk?.verdict !== "proceed" || verdicts.size?.verdict !== "proceed")) return { fast: false, failing: "the risk or size signal is not sure enough to act on" };
  if (owners.owners === "cross_team" && !config.cross_team) return { fast: false, failing: `the change reaches ${owners.teams} owning teams` };
  if (owners.owners === "not_checked") return { fast: true, ownersNotChecked: owners.reason };
  return { fast: true };
}
