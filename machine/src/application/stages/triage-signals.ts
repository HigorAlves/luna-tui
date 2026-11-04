// Triage reads the ticket's signals: the triage_signals decision, run before triage for a ticket
// that arrived without them (a task made in the TUI, from Slack or by hand; GitHub and Jira
// intake classify theirs on the way in). The classification is saved on the task and rides
// into triage's stage input; a classifier that is absent, fails or answers nothing leaves triage
// to run as it did.
import type { IssueContext, TaskClassification } from "@hardness/contracts";

import type { TaskRow } from "../../domain/task.ts";
import type { StageRunner } from "../ports.ts";

export interface TriageSignalDeps {
  /** The classifier, once it exists (late-bound in main.ts); null when there is no Jev or fallback credential or agents are off. */
  classify: ((issue: IssueContext, repoPath: string | null) => Promise<TaskClassification | null>) | null;
  save: (id: string, patch: Partial<TaskRow>) => Promise<void>;
  log?: (line: string) => void;
}

const issueOf = (task: TaskRow): IssueContext => {
  const source = task.source;
  const ref = source && "url" in source ? source.url : source?.kind === "slack" ? source.permalink : undefined;
  return { title: task.title, description: task.description, labels: [], ...(ref ? { source: ref } : {}) };
};

export function withTriageSignals(triage: StageRunner, deps: TriageSignalDeps): StageRunner {
  const log = deps.log ?? ((line: string) => console.warn(line));
  return async (context) => {
    const { task } = context;
    if (task.classification || !deps.classify) return triage(context);
    let classification: TaskClassification | null = null;
    try {
      classification = await deps.classify(issueOf(task), task.repoPath);
      if (classification) await deps.save(task.id, { classification });
    } catch (error) {
      log(`triage signals for task ${task.id}: ${error instanceof Error ? error.message : String(error)}`);
      classification = null;
    }
    return triage(classification ? { ...context, task: { ...task, classification } } : context);
  };
}
