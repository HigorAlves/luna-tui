// The v2.2 diagram's plan objects: Criterion, Scenario, PlanStep and Plan. Every v2 field is optional or
// filled by a normaliser, so a plan gate payload or case list written before v2.2 still parses.
import { z } from "zod";

import type { Slice } from "./stage.ts";

/** Ids kept across an edit: a text that was in the list keeps its id, a new text takes the next free `C<n>`. */
export function reviseCriteria(previous: readonly Criterion[], texts: readonly string[]): Criterion[] {
  const taken = new Set<string>();
  const kept = texts.map((text) => {
    const same = previous.find((c) => c.text === text && !taken.has(c.id));
    if (same) taken.add(same.id);
    return same ?? null;
  });
  let next = previous.reduce((max, c) => Math.max(max, Number(/^C(\d+)$/.exec(c.id)?.[1] ?? 0)), 0);
  return texts.map((text, i) => kept[i] ?? { id: `C${++next}`, text });
}

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
  /** The files of `files` the step creates: planned, but absent from the code map. */
  new_files: z.array(z.string()).optional(),
  done_when: z.array(z.string()).optional(),
});
export type PlanStep = z.infer<typeof PlanStep>;

/** A step as the planner writes it: a description, its files (a path, or a path declared `new`), what makes it done and its size. */
export const AnswerStep = z.object({
  description: z.string(),
  title: z.string().optional(),
  files: z.array(z.union([z.string(), z.object({ path: z.string(), new: z.boolean().optional() })])),
  done_when: z.array(z.string()),
  est_loc: z.number().int(),
});
export type AnswerStep = z.infer<typeof AnswerStep>;

/** The planner's steps as plan steps (`files`, `new_files`, `done_when`) that also carry the slice fields (`title`, `touchpoints`, `acceptance`)
 *  Build, the test designer and the scope check read, and as those slices. A step's files are its touchpoints; a path is listed once. Pure. */
export function stepsOfAnswer(answer: readonly AnswerStep[]): { steps: PlanStep[]; slices: Slice[] } {
  const steps = answer.map((a): PlanStep => {
    const paths = [...new Set(a.files.map((f) => (typeof f === "string" ? f : f.path)))];
    const created = [...new Set(a.files.flatMap((f) => (typeof f !== "string" && f.new === true ? [f.path] : [])))];
    return { title: a.title ?? a.description, description: a.description, est_loc: a.est_loc, files: paths, new_files: created, done_when: a.done_when, touchpoints: paths, acceptance: a.done_when };
  });
  return { steps, slices: steps.map((s) => ({ title: s.title, est_loc: s.est_loc, touchpoints: s.touchpoints, acceptance: s.acceptance })) };
}

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
  /** Rises on every revision (a planner re-run, a person's edit); 2 when not given. */
  version?: number;
}): Plan {
  const plan: Plan = {
    goal: parts.brief ?? "",
    steps: (parts.slices ?? []).map(stepOf),
    acceptance_criteria: criteriaOf(parts.criteria ?? []),
    out_of_scope: [...(parts.outOfScope ?? [])],
    assumptions: [...(parts.assumptions ?? [])],
    rollback: parts.rollback ?? "",
    version: parts.version ?? 2,
  };
  if (parts.migration !== undefined) plan.migration = parts.migration;
  if (parts.flags !== undefined) plan.flags = [...parts.flags];
  return plan;
}
