// The shared judge of a decision pack on a check context (red_check, scope_check, finding_classify,
// e2e_failure_cause): ask, apply the pack's policy and the repo's overrides, never throw.
import { recordIdOf } from "../decision-truth.ts";
import { type CheckContext, type DecisionOverrides, PACKS, type Verdict, applyPolicy } from "@hardness/contracts";

export type CheckPack = "red_check" | "scope_check" | "escalation_reason" | "finding_classify" | "e2e_failure_cause" | "ci_failure_class";

/** Runs a decision pack on a check context and returns its answer; bound late, once PackRuns exists. */
export type Decide = (pack: CheckPack, check: CheckContext, repoPath: string | null) => Promise<Record<string, unknown>>;

/** The pack's verdict over its answer; "skipped" when there is no decision to ask or it failed. */
export async function judgeCheck(
  decide: Decide | null,
  pack: CheckPack,
  check: CheckContext,
  repoPath: string | null,
  overrides: Record<string, DecisionOverrides>,
  log: (line: string) => void = () => {},
): Promise<{ verdict: Verdict | "skipped"; answer: Record<string, unknown> | null; recordId?: string }> {
  if (!decide) return { verdict: "skipped", answer: null };
  try {
    const answer = await decide(pack, check, repoPath);
    const recordId = recordIdOf(answer);
    return { verdict: applyPolicy(PACKS[pack], answer, overrides[pack]).overall, answer, ...(recordId ? { recordId } : {}) };
  } catch (error) {
    log(`check decision: ${pack} skipped: ${error instanceof Error ? error.message : String(error)}`);
    return { verdict: "skipped", answer: null };
  }
}
