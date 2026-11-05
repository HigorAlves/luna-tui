// The v2.2 diagram's plan objects: Criterion, Scenario, PlanStep and Plan. Every v2 field is optional or
// filled by a normaliser, so a plan gate payload or case list written before v2.2 still parses.
import { z } from "zod";

import type { Slice } from "./stage.ts";

/** Ids kept across an edit: a text that was in the list keeps its id, a new text takes the next free `C<n>`. */
export function reviseCriteria(previous: readonly Criterion[], texts: readonly string[], floor = 0): Criterion[] {
  const taken = new Set<string>();
  const kept = texts.map((text) => {
    const same = previous.find((c) => c.text === text && !taken.has(c.id));
    if (same) taken.add(same.id);
    return same ?? null;
  });
  // The next id is past every id ever handed out: the Plan's high-water mark (`floor`), and any id in hand. A retired id is never reused.
  let next = previous.reduce((max, c) => Math.max(max, Number(/^C(\d+)$/.exec(c.id)?.[1] ?? 0)), floor);
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

/** A scenario as the designer writes it: the criterion it proves by id, its type, given/when/then, the data it needs and the layer that proves it. */
export const AnswerScenario = z.object({
  criterion_ref: z.string(),
  type: ScenarioType,
  given: z.string(),
  when: z.string(),
  then: z.string(),
  data_needs: z.array(z.string()).optional(),
  layer: ScenarioLayer,
});
export type AnswerScenario = z.infer<typeof AnswerScenario>;

/** A scenario as the line a later stage reads: given/when/then when it has all three, else its approach (a v1 case). */
export function scenarioText(s: { approach: string; given?: string | null; when?: string | null; then?: string | null }): string {
  return s.given && s.when && s.then ? `given ${s.given}, when ${s.when}, then ${s.then}` : s.approach;
}

const TITLE_MAX = 120;
/** The longest a step's description or a `done_when` line may be, and a scenario's given, when, then and data need. */
const STEP_TEXT_MAX = 500;
const SCENARIO_TEXT_MAX = 300;

/** The designer's scenarios as the scenarios the machine stores: `S1`... by position, the criterion's text by its ref (an unknown ref ties to nothing),
 *  a title from `then` (told apart by the id when another scenario has it) for the places that key on one, an approach that says the scenario in
 *  full, and the designer round as `version`. Pure. */
export function scenariosOfAnswer(answer: readonly AnswerScenario[], criteria: readonly Criterion[], version: number): Scenario[] {
  const seen = new Map<string, number>();
  return answer.map((a, i) => {
    const id = `S${i + 1}`;
    const criterion = criteria.find((c) => c.id === a.criterion_ref) ?? null;
    const given = oneLine(a.given, SCENARIO_TEXT_MAX);
    const when = oneLine(a.when, SCENARIO_TEXT_MAX);
    const then = oneLine(a.then, SCENARIO_TEXT_MAX);
    const base = then.slice(0, TITLE_MAX) || id;
    seen.set(base, (seen.get(base) ?? 0) + 1);
    return {
      id,
      title: seen.get(base)! > 1 ? `${base} (${id})` : base,
      criterion: criterion?.text ?? null,
      criterion_ref: criterion?.id ?? null,
      type: a.type,
      given,
      when,
      then,
      approach: `Given ${given}, when ${when}, then ${then} (${a.layer})`,
      data_needs: (a.data_needs ?? []).map((need) => oneLine(need, SCENARIO_TEXT_MAX)),
      layer: a.layer,
      version,
    };
  });
}

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
  /** Paths the planner named that were not plain repo-relative paths (a glob, an absolute path, `..`): dropped from `files`, kept by name for the plan check. */
  dropped_files: z.array(z.string()).optional(),
  done_when: z.array(z.string()).optional(),
});
export type PlanStep = z.infer<typeof PlanStep>;

/** Text a model wrote, made one line and cut: whitespace (newlines included) collapsed, then at most `max` characters. */
export const oneLine = (text: string, max: number): string => text.replace(/\s+/g, " ").trim().slice(0, max);

const GLOB_CHARACTER = /[*?[\]{}]/;

/** A path a model named that the machine may treat as one file: relative to the repo, no glob character, no `..`, no NUL, no control character,
 *  not absolute (POSIX, drive or UNC), at most 300 characters. Anything else is dropped where it came in, never matched or opened. */
export function isPlainRepoPath(path: string): boolean {
  if (path.length === 0 || path.length > 300 || path.trim() !== path || path.trim() === "") return false;
  if (/[\u0000-\u001f\u007f]/.test(path) || GLOB_CHARACTER.test(path) || path.includes("\\")) return false;
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) return false;
  return !path.split("/").includes("..");
}

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
    const named = a.files.map((f) => (typeof f === "string" ? { path: f, created: false } : { path: f.path, created: f.new === true }));
    const plain = named.filter((f) => isPlainRepoPath(f.path));
    const dropped = [...new Set(named.filter((f) => !isPlainRepoPath(f.path)).map((f) => oneLine(f.path, 100)))];
    const paths = [...new Set(plain.map((f) => f.path))];
    const created = [...new Set(plain.filter((f) => f.created).map((f) => f.path))];
    const description = oneLine(a.description, STEP_TEXT_MAX);
    const doneWhen = a.done_when.map((line) => oneLine(line, STEP_TEXT_MAX));
    return { title: a.title ? oneLine(a.title, STEP_TEXT_MAX) : description, description, est_loc: a.est_loc, files: paths, new_files: created, ...(dropped.length ? { dropped_files: dropped } : {}), done_when: doneWhen, touchpoints: paths, acceptance: doneWhen };
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
  /** The highest criterion number ever handed out (`C<n>`): an id retired by an edit is never reused, so a scenario tied to it cannot be tied to another criterion. */
  next_criterion: z.number().int().optional(),
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
    next_criterion: criteriaOf(parts.criteria ?? []).length,
  };
  if (parts.migration !== undefined) plan.migration = parts.migration;
  if (parts.flags !== undefined) plan.flags = [...parts.flags];
  return plan;
}
