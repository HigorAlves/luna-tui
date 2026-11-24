// The plan check's facts, by script: every criterion has a step whose done-when names it, every step's file is in the code
// map or declared new, the rollback is there. What a script cannot judge (does the plan fit the record, does it suit its
// risk) is the plan_check decision's, so the check never reads the plan's own claims about itself.
import type { Plan, Scenario } from "./plan.ts";
import type { CodeMapAnswer } from "./stage.ts";

export interface PlanFacts {
  ok: boolean;
  /** One line per finding, in the order criteria, files, rollback, scenarios. */
  issues: string[];
}

const squash = (text: string): string => text.replace(/\s+/g, " ").trim().toLowerCase();
const pathOf = (path: string): string => path.replace(/^(\.\/|\/work\/)/, "");

/** Whether a done-when line names a criterion: it carries the criterion's text (any case or spacing) or its id as a word. */
function names(line: string, criterion: { id: string; text: string }): boolean {
  return squash(line).includes(squash(criterion.text)) || new RegExp(`\\b${criterion.id}\\b`, "i").test(line);
}

export function planFacts(plan: Plan, scenarios: readonly Scenario[], map: CodeMapAnswer | null): PlanFacts {
  const issues: string[] = [];
  const notPlain = "is not a plain repo-relative path";
  for (const criterion of plan.acceptance_criteria) {
    if (!plan.steps.some((step) => (step.done_when ?? step.acceptance).some((line) => names(line, criterion)))) {
      issues.push(`${criterion.id} appears in no step's done_when: ${criterion.text}`);
    }
  }
  for (const dropped of map?.dropped ?? []) issues.push(`the code map named a path that ${notPlain}: ${dropped}`);
  const mapped = map ? new Set(map.files.map((f) => pathOf(f.path))) : null;
  for (const step of plan.steps) {
    const name = step.id ?? step.title;
    for (const dropped of step.dropped_files ?? []) issues.push(`${name} named a path that ${notPlain}: ${dropped}`);
    const files = step.files ?? step.touchpoints;
    if (files.length === 0) issues.push(`${name} names no file`);
    const created = new Set((step.new_files ?? []).map(pathOf));
    for (const file of files) {
      const path = pathOf(file);
      if (mapped && !mapped.has(path) && !created.has(path)) issues.push(`${name} touches ${path}, which the code map does not name and the step does not declare new`);
    }
  }
  if (plan.rollback.trim() === "") issues.push("the plan has no rollback");
  for (const scenario of scenarios) {
    if (scenario.criterion_ref && !plan.acceptance_criteria.some((c) => c.id === scenario.criterion_ref)) {
      issues.push(`scenario ${scenario.id ?? scenario.title} is tied to ${scenario.criterion_ref}, which is not a criterion of the plan`);
    }
  }
  return { ok: issues.length === 0, issues };
}
