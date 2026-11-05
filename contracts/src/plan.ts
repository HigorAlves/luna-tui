// The v2.2 diagram's plan objects: Criterion, Scenario, PlanStep and Plan. Every v2 field is optional or
// filled by a normaliser, so a plan gate payload or case list written before v2.2 still parses.
import { z } from "zod";

import type { Slice } from "./stage.ts";

/** One acceptance criterion with a stable id (`C1`...), the handle scenarios refer to. */
export const Criterion = z.object({ id: z.string(), text: z.string() });
export type Criterion = z.infer<typeof Criterion>;

/** Ids `C1`... by position, so the same list always gets the same ids. A list of criteria already
 *  carrying ids passes through. */
export function criteriaOf(criteria: readonly (string | Criterion)[]): Criterion[] {
  return criteria.map((c, i) => (typeof c === "string" ? { id: `C${i + 1}`, text: c } : c));
}

export const ScenarioType = z.enum(["happy", "edge", "failure"]);
export type ScenarioType = z.infer<typeof ScenarioType>;
export const ScenarioLayer = z.enum(["unit", "integration", "e2e"]);
export type ScenarioLayer = z.infer<typeof ScenarioLayer>;

/** The diagram's Scenario. `title`, `criterion` and `approach` are today's TestCase fields; the rest is
 *  v2 and optional, so a v1 case is a valid scenario on the wire. */
export const Scenario = z.object({
  title: z.string(),
  criterion: z.string().nullable(),
  /** Free text: what to check, and the repo's own command when one applies. */
  approach: z.string(),
  id: z.string().optional(),
  criterion_ref: z.string().nullable().optional(),
  type: ScenarioType.optional(),
  given: z.string().nullable().optional(),
  when: z.string().nullable().optional(),
  then: z.string().nullable().optional(),
  data_needs: z.array(z.string()).optional(),
  layer: ScenarioLayer.nullable().optional(),
  version: z.number().int().optional(),
});
export type Scenario = z.infer<typeof Scenario>;

/** A v1 case becomes a v2 scenario: `id` from its position, `criterion_ref` by matching the criterion
 *  text to a criterion id, type `happy`, layer and given/when/then null. A scenario that has an id
 *  passes through. Pure. */
export function scenarioOf(testCase: Scenario, index: number, criteria: readonly Criterion[]): Scenario {
  if (testCase.id !== undefined) return testCase;
  const ref = testCase.criterion === null ? null : (criteria.find((c) => c.text === testCase.criterion)?.id ?? null);
  return {
    ...testCase,
    id: `S${index + 1}`,
    criterion_ref: ref,
    type: testCase.type ?? "happy",
    given: testCase.given ?? null,
    when: testCase.when ?? null,
    then: testCase.then ?? null,
    data_needs: testCase.data_needs ?? [],
    layer: testCase.layer ?? null,
    version: testCase.version ?? 2,
  };
}

/** The diagram's plan step: today's slice plus an id, a description, `files` (the slice's touchpoints)
 *  and `done_when` (its acceptance). */
export const PlanStep = z.object({
  title: z.string(),
  est_loc: z.number().int(),
  touchpoints: z.array(z.string()),
  acceptance: z.array(z.string()),
  id: z.string().optional(),
  description: z.string().optional(),
  files: z.array(z.string()).optional(),
  done_when: z.array(z.string()).optional(),
});
export type PlanStep = z.infer<typeof PlanStep>;

/** A slice as a plan step: `P1`... by position, `files` from `touchpoints`, `done_when` from `acceptance`. */
export function stepOf(slice: Slice | PlanStep, index: number): PlanStep {
  const step = slice as PlanStep;
  return {
    ...step,
    id: step.id ?? `P${index + 1}`,
    description: step.description ?? step.title,
    files: step.files ?? step.touchpoints,
    done_when: step.done_when ?? step.acceptance,
  };
}

/** The diagram's Plan. */
export const Plan = z.object({
  goal: z.string(),
  steps: z.array(PlanStep),
  acceptance_criteria: z.array(Criterion),
  out_of_scope: z.array(z.string()),
  assumptions: z.array(z.string()),
  rollback: z.string(),
  migration: z.string().optional(),
  flags: z.array(z.string()).optional(),
  version: z.number().int(),
});
export type Plan = z.infer<typeof Plan>;

/** Builds the diagram's Plan from today's plan parts. */
export function planOf(parts: {
  brief?: string;
  criteria?: readonly (string | Criterion)[];
  assumptions?: readonly string[];
  slices?: readonly (Slice | PlanStep)[];
  rollback?: string;
  outOfScope?: readonly string[];
  migration?: string;
  flags?: readonly string[];
}): Plan {
  const plan: Plan = {
    goal: parts.brief ?? "",
    steps: (parts.slices ?? []).map(stepOf),
    acceptance_criteria: criteriaOf(parts.criteria ?? []),
    out_of_scope: [...(parts.outOfScope ?? [])],
    assumptions: [...(parts.assumptions ?? [])],
    rollback: parts.rollback ?? "",
    version: 2,
  };
  if (parts.migration !== undefined) plan.migration = parts.migration;
  if (parts.flags !== undefined) plan.flags = [...parts.flags];
  return plan;
}
