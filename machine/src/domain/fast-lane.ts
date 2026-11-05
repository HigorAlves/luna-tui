// The fast lane, a rule the machine checks and never the agent's own word: low risk, small, not infra or data, one owning
// team (or none), and the risk and size signals sure enough to act on. Pure.
import type { FactoryConfig, TriageRecord } from "@hardness/contracts";

import type { RequiredOwners } from "./codeowners.ts";
import type { FieldVerdict, TriageField } from "./triage-policy.ts";

const RISK = ["low", "medium", "high"] as const;
const SIZE = ["XS", "S", "M", "L", "XL"] as const;

export type FastLane = { fast: true; skipped?: string } | { fast: false; failing: string };

/** `owners`: what `locate` found for the card's words; null when the repo has no graph, which skips the owners condition and says so. */
export function fastLane(
  record: Partial<Pick<TriageRecord, "riskPrelim" | "size" | "typeOfWork">>,
  owners: RequiredOwners[] | null,
  config: FactoryConfig["fast_lane"],
  verdicts?: Partial<Record<TriageField, Pick<FieldVerdict, "verdict">>>,
): FastLane {
  const risk = RISK.indexOf(record.riskPrelim as (typeof RISK)[number]);
  if (risk < 0 || risk > RISK.indexOf(config.max_risk)) return { fast: false, failing: `preliminary risk is ${record.riskPrelim ?? "unknown"}, above ${config.max_risk}` };
  const size = SIZE.indexOf(record.size as (typeof SIZE)[number]);
  if (size < 0 || size > SIZE.indexOf(config.max_size)) return { fast: false, failing: `size is ${record.size ?? "unknown"}, above ${config.max_size}` };
  if (!record.typeOfWork || config.excluded_types.includes(record.typeOfWork)) return { fast: false, failing: `type of work ${record.typeOfWork ?? "unknown"} is not for the fast lane` };
  if (verdicts && (verdicts.risk?.verdict !== "proceed" || verdicts.size?.verdict !== "proceed")) return { fast: false, failing: "the risk or size signal is not sure enough to act on" };
  if (owners === null) return { fast: true, skipped: "no code graph: the owning-team condition was not checked" };
  const teams = new Set(owners.flatMap((o) => o.owners));
  if (!config.cross_team && teams.size > 1) return { fast: false, failing: `the change reaches ${teams.size} owning teams` };
  return { fast: true };
}
