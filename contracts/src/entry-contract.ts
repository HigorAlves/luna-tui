// The entry contract of Build (diagram panel 4): what Plan must hand over before the implementer runs. Pure, a script's fact, not a model's opinion.
import type { Plan, Scenario } from "./plan.ts";

export interface EntryContractInput {
  plan: Plan | null;
  scenarios: readonly Scenario[];
  /** Criterion ids the gate excused as untestable: no scenario is asked for them. */
  untestable: readonly string[];
  map: unknown;
  /** Why there is no code map (the gate's note), when there is none. */
  mapNote: string | null;
  risk: { level: string } | null;
  record: unknown;
  /** A gate approved before v2.2 (no `plan` object, cases without ids): read through the wave 8 normalisers and held to a lighter contract. */
  legacy?: boolean;
}

export interface EntryContractResult {
  ok: boolean;
  /** What is absent, one line each, for the re-plan evidence and the stream row. */
  missing: string[];
  readAs: "v1" | "v2";
}

export function entryContract(input: EntryContractInput): EntryContractResult {
  const { plan, scenarios } = input;
  const missing: string[] = [];
  if (input.legacy === true) {
    if (plan === null || (plan.goal.trim() === "" && plan.steps.length === 0)) missing.push("an approved plan (a brief or slices)");
    if (scenarios.length === 0) missing.push("at least one test case");
    return { ok: missing.length === 0, missing, readAs: "v1" };
  }
  if (plan === null || !Number.isInteger(plan.version)) missing.push("an approved plan with a version");
  if (plan !== null) {
    const excused = new Set(input.untestable);
    const proved = new Set(scenarios.map((s) => s.criterion_ref ?? null));
    for (const c of plan.acceptance_criteria) {
      if (!excused.has(c.id) && !proved.has(c.id)) missing.push(`a scenario for criterion ${c.id}`);
    }
    const planned = plan.steps.some((s) => (s.files ?? s.touchpoints).length > 0);
    if (!planned) missing.push("at least one planned file");
  }
  if (input.map == null && (input.mapNote === null || input.mapNote.trim() === "")) missing.push("a code map, or the note saying why there is none");
  if (input.risk == null || !input.risk.level) missing.push("a risk level");
  if (input.record == null) missing.push("the Triage record");
  return { ok: missing.length === 0, missing, readAs: "v2" };
}
