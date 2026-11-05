// Reads the entry contract of Build off the approved plan gate. A gate approved before v2.2 (no `plan` object) is read through
// `planOf` and `scenarioOf` and held to the lighter v1 contract.
import { CodeMapAnswer, entryContract, type EntryContractResult, Plan, PlanRisk, Scenario, planOf, scenarioOf, criteriaOf } from "@hardness/contracts";

import type { ApprovalRow } from "./task.ts";

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : []);

export function buildEntryOf(approvals: readonly ApprovalRow[], record: unknown): EntryContractResult {
  const approval = approvals.findLast((a) => a.kind === "awaiting_approval" && a.decision === "approved");
  if (!approval) return entryContract({ plan: null, scenarios: [], untestable: [], map: null, mapNote: null, risk: null, record });
  const requested = approval.requested;
  const parsedPlan = Plan.safeParse(requested.plan);
  // The lighter v1 contract is for a gate written before the v2.2 Plan: one with no `plan` at all. A plan that is there but invalid is a missing plan.
  const legacy = requested.plan === undefined;
  const plan: Plan | null = parsedPlan.success
    ? parsedPlan.data
    : !legacy
      ? null
      : planOf({ brief: typeof requested.brief === "string" ? requested.brief : "", criteria: strings(requested.criteria), slices: Array.isArray(requested.slices) ? requested.slices : [] });
  const criteria = plan && plan.acceptance_criteria.length ? plan.acceptance_criteria : criteriaOf(strings(requested.criteria));
  const scenarios = (Array.isArray(requested.cases) ? requested.cases : []).flatMap((c, i) => {
    const parsed = Scenario.safeParse(c);
    return parsed.success ? [scenarioOf(parsed.data, i, criteria)] : [];
  });
  const report = requested.coverageReport as { untestable?: unknown } | undefined;
  const map = CodeMapAnswer.safeParse(requested.map);
  const risk = PlanRisk.safeParse(requested.risk);
  return entryContract({
    plan,
    scenarios,
    untestable: strings(report?.untestable),
    map: map.success ? map.data : null,
    mapNote: typeof requested.mapNote === "string" ? requested.mapNote : null,
    risk: risk.success ? risk.data : null,
    record,
    legacy,
  });
}
