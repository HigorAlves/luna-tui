// Triage's first step for every source: the triage_signals decision, run on each entry to the stage (the first
// run and each return from awaiting_answers) with the answers so far in the issue it reads. The reading replaces
// the card's classification; a classifier that is absent, fails or answers nothing leaves the previous one and
// says so, and triage goes on.
import { type ClassifyOptions, type FactoryConfig, type IssueContext, RecordDraft, type TaskClassification, TriageRecord } from "@hardness/contracts";

import type { TaskRow } from "../../domain/task.ts";
import type { StageContext, StageResult, StageRunner } from "../ports.ts";

export interface TriageSignalDeps {
  /** The classifier, once it exists (late-bound in main.ts); null when there is no Jev or fallback credential or agents are off. */
  classify: ((issue: IssueContext, repoPath: string | null, options?: ClassifyOptions) => Promise<TaskClassification | null>) | null;
  /** The repo's policy: its scoring weights and bands turn the sub-scores into a priority. Absent: the diagram's. */
  policy?: (repoPath: string) => Promise<{ factory: FactoryConfig }>;
  save: (id: string, patch: Partial<TaskRow>) => Promise<void>;
  log?: (line: string) => void;
}

const MAX_ANSWERS = 20;
const MAX_ANSWER_CHARS = 2000;

const issueOf = (task: TaskRow, answers: NonNullable<IssueContext["answers"]>): IssueContext => {
  const source = task.source;
  const ref = source && "url" in source ? source.url : source?.kind === "slack" ? source.permalink : undefined;
  return { title: task.title, description: task.description, labels: [], ...(ref ? { source: ref } : {}), ...(answers.length > 0 ? { answers } : {}) };
};

/** What the person answered at the questions gates so far, oldest first; an answer that is not text is dropped. */
function answersOf(approvals: StageContext["approvals"]): NonNullable<IssueContext["answers"]> {
  return approvals
    .flatMap((a) => {
      if (a.decision !== "answered") return [];
      return Object.entries((a.response?.answers ?? {}) as Record<string, unknown>).flatMap(([question, answer]) => (typeof answer === "string" ? [{ question: question.slice(0, MAX_ANSWER_CHARS), answer: answer.slice(0, MAX_ANSWER_CHARS) }] : []));
    })
    .slice(0, MAX_ANSWERS);
}

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
    if (deps.classify) {
      const kept = task.classification ? "the previous reading is kept" : "going on without one";
      try {
        const repo = task.repoPath ? await deps.policy?.(task.repoPath).catch(() => null) : null;
        const options: ClassifyOptions = repo ? { weights: repo.factory.scoring.weights, bands: repo.factory.scoring.bands } : {};
        classification = await deps.classify(issueOf(task, answersOf(context.approvals)), task.repoPath, options);
        if (classification) await deps.save(task.id, { classification });
        else await context.note?.(`triage signals gave no reading; ${kept}`).catch(() => {});
      } catch (error) {
        const why = error instanceof Error ? error.message : String(error);
        log(`triage signals for task ${task.id}: ${why}`);
        await context.note?.(`triage signals failed (${why}); ${kept}`).catch(() => {});
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
