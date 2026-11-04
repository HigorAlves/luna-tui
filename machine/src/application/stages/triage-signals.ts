// Triage reads the ticket's signals: the triage_signals decision, run before triage for a ticket
// that arrived without them (a task made in the TUI, from Slack or by hand; GitHub and Jira
// intake classify theirs on the way in). The classification is saved on the task and rides
// into triage's stage input; a classifier that is absent, fails or answers nothing leaves triage
// to run as it did.
import { type IssueContext, RecordDraft, type TaskClassification, TriageRecord } from "@hardness/contracts";

import type { TaskRow } from "../../domain/task.ts";
import type { StageContext, StageResult, StageRunner } from "../ports.ts";

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

/** The record triage's draft becomes: the machine's own facts around the draft's words. Null when there is no valid draft. */
function recordOf(context: StageContext, result: StageResult, task: TaskRow): TriageRecord | null {
  const draft = RecordDraft.safeParse(result.detail?.record);
  if (!draft.success) return null;
  const outcome = result.detail?.outcome;
  const qa = context.approvals.flatMap((a) => {
    if (a.decision !== "answered") return [];
    const answers = (a.response?.answers ?? {}) as Record<string, unknown>;
    return Object.entries(answers).map(([question, answer]) => ({ question, answer: typeof answer === "string" ? answer : null }));
  });
  const parsed = TriageRecord.safeParse({
    ...draft.data,
    source: task.source?.kind ?? "manual",
    decision: typeof outcome === "string" ? outcome : "plan",
    signals: task.classification?.signals ?? {},
    qa,
    at: new Date().toISOString(),
    model: result.run?.info?.modelId ?? "unknown",
  });
  return parsed.success ? parsed.data : null;
}

export function withTriageSignals(triage: StageRunner, deps: TriageSignalDeps): StageRunner {
  const log = deps.log ?? ((line: string) => console.warn(line));
  return async (context) => {
    const { task } = context;
    let classification: TaskClassification | null = null;
    if (!task.classification && deps.classify) {
      try {
        classification = await deps.classify(issueOf(task), task.repoPath);
        if (classification) await deps.save(task.id, { classification });
      } catch (error) {
        log(`triage signals for task ${task.id}: ${error instanceof Error ? error.message : String(error)}`);
        classification = null;
      }
    }
    const enriched = classification ? { ...context, task: { ...task, classification } } : context;
    const result = await triage(enriched);
    if (result.outcome === "pass") {
      const record = recordOf(enriched, result, enriched.task);
      if (record) {
        try {
          await deps.save(task.id, { record });
        } catch (error) {
          log(`triage record for task ${task.id}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    return result;
  };
}
