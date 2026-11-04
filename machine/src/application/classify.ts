// Intake's first read of a new issue: triage_signals (Jev, else its fallback engine), run through PackRuns like a `POST /runs`
// call (the stage container, the Jev credential by name, a pack_runs row for its cost, the day's
// ceiling). Without a Jev credential it says nothing and intake goes on exactly as before; any
// other failure is logged once per issue and intake goes on as before. Never throws.
import { type DecisionOverrides, type IssueContext, PACKS, type TaskClassification, classificationOf } from "@hardness/contracts";

import { type PackRunsPort, RunNoCredentialError } from "./pack-runs.ts";

/** Who intake's runs are recorded as in pack_runs. */
export const INTAKE_CLIENT = "intake";

export interface IssueClassifier {
  /** The classification of one issue, or null when there is none to have (no Jev credential, a failed run). */
  classify(issue: IssueContext): Promise<TaskClassification | null>;
}

/** Whether intake may act on a classification alone: Jev calls the issue a question and is at or
 *  above the pack's floor on that kind (the other answers do not bear on it; a classification
 *  stored before `kindConfidence` falls back to its lowest). Anything less goes to jira_intake. */
export function confidentQuestion(c: TaskClassification | null, overrides: DecisionOverrides = {}): c is TaskClassification {
  if (c === null || c.kind !== "question") return false;
  const bar = { ...PACKS.triage_signals.policy.kind, ...overrides.kind };
  return (c.kindConfidence ?? c.confidence) >= bar.proceed!;
}

export function createIssueClassifier(deps: { runs: PackRunsPort; now?: () => Date; log?: (line: string) => void }): IssueClassifier {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((line: string) => console.warn(line));
  return {
    async classify(issue) {
      try {
        const { answer, usage } = await deps.runs.run({ pack: "triage_signals", context: { issue } }, INTAKE_CLIENT);
        return classificationOf(answer, usage.model, now());
      } catch (thrown) {
        if (!(thrown instanceof RunNoCredentialError)) log(`intake: could not classify ${issue.source ?? issue.title}: ${thrown instanceof Error ? thrown.message : String(thrown)}; going on without it`);
        return null;
      }
    },
  };
}
