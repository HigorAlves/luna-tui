// One designer run (design_spec, a11y_audit; phase 3 adds design_parity) with the design budget read before and after it, as Build's is (RFC 0013, Budget).
// A spent budget starts no run: the card escalates `design_budget` and a person decides. Each run leaves one `design.run` row the budget counts.
import type { DesignBudget } from "../../domain/design-budget.ts";
import type { StageContext, StageResult } from "../ports.ts";

export type DesignPack = "design_spec" | "a11y_audit" | "design_parity";

export interface DesignRunDeps {
  /** The card's design budget now; absent, no budget applies (a machine built without one, or a test). */
  budget?: (taskId: string) => Promise<DesignBudget>;
  now?: () => number;
}

/** The result of a designer step that may not run: the numbers, and the two things a person can do. */
export function designBudgetEscalation(budget: DesignBudget): StageResult {
  const said = budget.spent === "tokens" ? `${budget.tokens} of ${budget.limits.max_tokens} tokens` : `${budget.minutes} of ${budget.limits.max_minutes} minutes`;
  return {
    outcome: "escalated",
    detail: {
      escalation: "design_budget",
      reason: `the design budget is spent: ${said}; a person decides`,
      designBudget: { ...budget },
      options: ["approve to give the card a fresh design budget", "approve with design off to go on without the designer agents", "raise design.budget in luna.yaml"],
    },
  };
}

export async function designRun(deps: DesignRunDeps, context: StageContext, pack: DesignPack, run: () => Promise<StageResult>): Promise<{ result: StageResult; spentAfter: boolean }> {
  const before = deps.budget ? await deps.budget(context.task.id) : null;
  if (before?.spent) return { result: designBudgetEscalation(before), spentAfter: true };
  const now = deps.now ?? Date.now;
  const t0 = now();
  const result = await run();
  const t = result.usage?.tokens;
  const tokens = t && Number.isInteger(t.input) && Number.isInteger(t.output) ? t.input + t.output : null;
  const minutes = Math.round(((now() - t0) / 60_000) * 10) / 10;
  await Promise.resolve(context.emit?.("design.run", { pack, tokens, minutes, outcome: result.outcome })).catch(() => {});
  const after = deps.budget ? await deps.budget(context.task.id) : null;
  return { result, spentAfter: Boolean(after?.spent) };
}
