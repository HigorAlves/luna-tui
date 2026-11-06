// Coverage of the acceptance criteria by the scenarios, by id: a script, never a model. The coverage_check decision judges
// what a script cannot (does a scenario pin its criterion, is one redundant, is a criterion untestable); which criteria have
// no scenario, which are thin and the score come from here.
import type { Criterion, Scenario, ScenarioType } from "./plan.ts";

/** One criterion with the scenarios that name it. */
export interface CriterionCoverage {
  criterion: Criterion;
  /** Ids of the scenarios that reference the criterion. */
  scenarios: string[];
  /** Their types, in the same order (a v1 case with no type reads as `happy`). */
  types: ScenarioType[];
  covered: boolean;
}

export interface Coverage {
  per: CriterionCoverage[];
  /** Ids of the criteria no scenario names. */
  gaps: string[];
  /** Ids of the covered criteria that name a limit or an error but have no edge or failure scenario. */
  thin: string[];
  /** The criteria judged untestable, as given. */
  untestable: string[];
  /** Covered criteria over all, the untestable ones left out of both sides; 1 when none is left. */
  score: number;
}

const LIMIT_OR_ERROR =
  /\b(at most|at least|no more than|no fewer|more than|fewer than|less than|up to|maximum|minimum|max|min|limit\w*|empty|blank|zero|none|invalid|errors?|fail(s|ed|ure|ures)?|refus\w*|reject\w*|den(y|ies|ied)|expire\w*|exceed\w*|unauthori[sz]ed|forbidden|time ?outs?|overflow\w*|too (long|many|large|short|small)|lock(s|ed)?|never|cannot|can't)\b/i;

/** Whether a criterion's text names a limit or an error, where an edge or failure scenario is expected. A reading of the words, not of the intent. */
export const namesLimitOrError = (text: string): boolean => LIMIT_OR_ERROR.test(text);

/** A scenario belongs to the criterion its ref names; one with no ref belongs to the criterion whose text it carries (a v1 case). */
function belongsTo(scenario: Scenario, criterion: Criterion): boolean {
  if (scenario.criterion_ref !== undefined && scenario.criterion_ref !== null) return scenario.criterion_ref === criterion.id;
  return scenario.criterion !== null && scenario.criterion.trim() === criterion.text.trim();
}

export function coverageOf(
  criteria: readonly Criterion[],
  scenarios: readonly Scenario[],
  options: { untestable?: readonly string[]; expectsEdge?: (criterion: Criterion) => boolean } = {},
): Coverage {
  const untestable = (options.untestable ?? []).filter((id) => criteria.some((c) => c.id === id));
  const expectsEdge = options.expectsEdge ?? ((c: Criterion) => namesLimitOrError(c.text));
  const per = criteria.map((criterion): CriterionCoverage => {
    const named = scenarios.filter((s) => belongsTo(s, criterion));
    return { criterion, scenarios: named.map((s) => s.id ?? ""), types: named.map((s) => s.type ?? "happy"), covered: named.length > 0 };
  });
  const counted = per.filter((p) => !untestable.includes(p.criterion.id));
  return {
    per,
    gaps: per.filter((p) => !p.covered).map((p) => p.criterion.id),
    thin: per.filter((p) => p.covered && expectsEdge(p.criterion) && !p.types.some((t) => t === "edge" || t === "failure")).map((p) => p.criterion.id),
    untestable,
    score: counted.length === 0 ? 1 : counted.filter((p) => p.covered).length / counted.length,
  };
}
