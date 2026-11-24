// Intake's first read of a new issue: triage_signals (Jev, else its fallback engine), run through PackRuns like a `POST /runs`
// call (the stage container, the Jev credential by name, a pack_runs row for its cost, the day's
// ceiling). Without a Jev credential it says nothing and intake goes on exactly as before; any
// other failure is logged once per issue and intake goes on as before. Never throws.
import { type ClassifyOptions, type DecisionOverrides, type IssueContext, PACKS, type TaskClassification, classificationOf } from "@hardness/contracts";

import { type PackRunsPort, RunNoCredentialError } from "./pack-runs.ts";

/** Who intake's runs are recorded as in pack_runs. */
export const INTAKE_CLIENT = "intake";

export interface IssueClassifier {
  /** The classification of one issue, or null when there is none to have (no Jev credential, a failed run).
   *  `options` are the repo's scoring weights and bands; a `security` label on the issue is a P0 flag either way. */
  classify(issue: IssueContext, options?: ClassifyOptions): Promise<TaskClassification | null>;
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
    async classify(issue, options = {}) {
      try {
        const { answer, usage, recordId } = await deps.runs.run({ pack: "triage_signals", context: { issue } }, INTAKE_CLIENT);
        const security = (issue.labels ?? []).some((label) => label.toLowerCase() === "security");
        return { ...classificationOf(answer, usage.model, now(), { ...options, flags: { ...(security ? { security: true } : {}), ...options.flags } }), ...(recordId ? { recordId } : {}) };
      } catch (thrown) {
        if (!(thrown instanceof RunNoCredentialError)) log(`intake: could not classify ${issue.source ?? issue.title}: ${thrown instanceof Error ? thrown.message : String(thrown)}; going on without it`);
        return null;
      }
    },
  };
}
