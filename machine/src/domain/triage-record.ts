// The Triage Record, composed by the machine. The agent writes three things (a summary of at most 120 words, the goal
// sentence, and its decision with the reason); everything else is a fact the machine already holds: the signals, the
// priority, the preliminary risk, who answered what. `recordComplete` is a script over the result, so a card never
// leaves triage with a record that is missing a field.
import { type RecordDraft, type TaskClassification, TriageRecord, type TriageOutcome } from "@hardness/contracts";

export const MAX_SUMMARY_WORDS = 120;
/** What the agent writes is capped when the machine composes the record: a model's text is not trusted to be short. */
export const MAX_FIELD_CHARS = 2000;

export interface ComposeInput {
  /** What the agent wrote: the goal sentence and its reason; the summary may ride in the draft or come from the answer. */
  draft: Pick<RecordDraft, "goal" | "reason"> & { summary?: string | undefined };
  /** The answer's own summary, used when the draft carries none. */
  summary?: string | undefined;
  classification: TaskClassification | null;
  /** Where the card came from (`github`, `jira`, `slack`, `manual`). */
  source: string;
  decision: TriageOutcome;
  qa: Array<{ question: string; answer: string | null }>;
  goalRef: string;
  hintsUsed?: string[];
  /** Why the fast lane was taken without looking at the owners (no graph, a stale one...); the plan gate lists it. */
  ownersNotChecked?: string;
  /** The record this one replaces, when triage ran before. */
  previous?: { version?: number | undefined } | null;
  model: string;
  at: string;
}

/** The record as far as the facts reach: fields the machine could not fill are left out, and `recordComplete` names them. */
export function composeRecord(input: ComposeInput): Partial<TriageRecord> {
  const c = input.classification;
  const summary = (input.draft.summary ?? input.summary ?? "").trim().slice(0, MAX_FIELD_CHARS);
  const version = input.previous ? (input.previous.version ?? 1) + 1 : 1;
  return {
    source: input.source,
    goal: input.draft.goal.trim().slice(0, MAX_FIELD_CHARS),
    reason: input.draft.reason.trim().slice(0, MAX_FIELD_CHARS),
    decision: input.decision,
    signals: c?.signals ?? {},
    qa: input.qa,
    at: input.at,
    model: input.model,
    ...(summary ? { summary } : {}),
    ...(c?.kind ? { kind: c.kind } : {}),
    ...(c?.typeOfWork ? { typeOfWork: c.typeOfWork } : {}),
    ...(c?.sizeBucket ? { size: c.sizeBucket } : {}),
    ...(c?.priority ? { urgency: c.priority } : {}),
    ...(c?.riskPrelim ? { risk: c.riskPrelim } : {}),
    ...(c?.priority && c.subScores ? { urgencyDetail: { priority: c.priority, subScores: c.subScores } } : {}),
    ...(c?.riskPrelim ? { riskPrelim: c.riskPrelim, riskMachine: c.riskPrelim } : {}),
    goalRef: input.goalRef,
    hintsUsed: input.hintsUsed ?? [],
    decisionBy: "machine",
    ...(input.ownersNotChecked ? { ownersNotChecked: input.ownersNotChecked.slice(0, 200) } : {}),
    version,
  };
}

const words = (text: string): number => text.trim().split(/\s+/).filter(Boolean).length;

/** Every required field present, the summary within 120 words, the goal written (or an explicit `none`). */
export function recordComplete(record: Partial<TriageRecord> | null): { complete: boolean; missing: string[] } {
  if (!record) return { complete: false, missing: ["the whole record"] };
  const missing: string[] = [];
  const need = (field: string, present: boolean) => {
    if (!present) missing.push(field);
  };
  need("kind", Boolean(record.kind));
  need("type of work", Boolean(record.typeOfWork));
  need("size", Boolean(record.size));
  need("urgency", Boolean(record.urgencyDetail));
  need("preliminary risk", Boolean(record.riskPrelim));
  need("goal (a sentence, or `none`)", Boolean(record.goal?.trim()));
  need("reason", Boolean(record.reason?.trim()));
  need("decision", Boolean(record.decision));
  need("goal reference", Boolean(record.goalRef));
  need("summary", Boolean(record.summary?.trim()));
  if (record.summary?.trim() && words(record.summary) > MAX_SUMMARY_WORDS) missing.push(`a summary of at most ${MAX_SUMMARY_WORDS} words (this one has ${words(record.summary)})`);
  if (missing.length === 0 && !TriageRecord.safeParse(record).success) missing.push("a record that fits the schema");
  return { complete: missing.length === 0, missing };
}
