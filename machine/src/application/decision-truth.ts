// Ground truth for decision packs: when a later fact settles what a decision should have said, the
// machine writes that label onto the decision's record (RFC 0005 wave 7). Each derivation below is
// one fact to one label, in the answer's shape: a scalar is what the question's answer should have
// been (`equals`), an array the labels it may have been (`oneOf`) for a fact that only rules one out.
// A decision's record id travels on its answer as a symbol-keyed property: it survives the spreads
// and hand-offs between a decide function and its stage, and never reaches JSON.
import type { DecisionPack, DecisionTruth as Truth, PackId, TaskClassification, TriageRecord } from "@hardness/contracts";

import type { DecisionLog } from "./decision-log.ts";
import type { FieldVerdict, TriageField } from "../domain/triage-policy.ts";

const RECORD_ID = Symbol("decision.recordId");

/** An answer carrying the id of the record the call left, when it left one. */
export function tagged(result: { answer: Record<string, unknown>; recordId?: string }): Record<string, unknown> {
  const answer = { ...result.answer };
  if (result.recordId !== undefined) Object.defineProperty(answer, RECORD_ID, { value: result.recordId, enumerable: true });
  return answer;
}

export function recordIdOf(answer: unknown): string | undefined {
  const id = answer !== null && typeof answer === "object" ? (answer as Record<symbol, unknown>)[RECORD_ID] : undefined;
  return typeof id === "string" ? id : undefined;
}

/** What a stage keeps of its decisions' records, so a later fact can find them: pack name to record id. */
export type DecisionIds = Partial<Record<PackId, string>>;

export type Label = Record<string, Record<string, unknown>>;

export const e2eCauseTruth = (rerunPassed: boolean): Label => ({ cause: { choice: rerunPassed ? "env_flake" : ["product_bug", "test_bug"] } });
/** The decision's own label for the stored format (`video`, `captures`, `text`). */
const FORMAT_LABEL: Record<string, string> = { video: "video", captures: "screenshots_or_terminal", text: "text_only" };
export const evidenceFormatTruth = (format: string): Label => ({ format: { choice: FORMAT_LABEL[format] ?? format } });
/** `testRewritten`: the slice went red again after the judged red, because the test was changed. */
export const redCheckTruth = (testRewritten: boolean): Label => ({ right_reason: { value: !testRewritten } });
export const worthLearningTruth = (approved: boolean): Label => ({ worth: { value: approved } });
export const eventClassTruth = (furtherActivity: boolean): Label => ({ event: { choice: furtherActivity ? "review_comment" : "noise" } });
export const commentIntentTruth = (kind: "question" | "change_request"): Label => ({ intent: { choice: kind } });
/** A finding a person shipped with was not a blocker, whatever the model said. */
export const findingTruth = (): Label => ({ severity: { choice: ["should_fix", "nit"] } });

/** The plan gate's verdict on one of its packs: confirmed (approved untouched) keeps every answer, rounding
 *  a score to its level; contradicted (edited, or sent back) flips each yes/no and leaves a score
 *  unlabelled, because nothing says what the right level was. Null when nothing is left to label. */
export function planTruth(pack: Pick<DecisionPack, "questions">, answer: Record<string, unknown>, outcome: "confirmed" | "contradicted"): Label | null {
  const label: Label = {};
  for (const [name, question] of Object.entries(pack.questions)) {
    const given = answer[name] as Record<string, unknown> | undefined;
    if (!given) continue;
    if (question.type === "yesno" && typeof given.value === "boolean") label[name] = { value: outcome === "confirmed" ? given.value : !given.value };
    else if (question.type === "score" && outcome === "confirmed" && typeof given.score === "number") label[name] = { score: Math.round(given.score) };
  }
  return Object.keys(label).length > 0 ? label : null;
}

export interface Learned {
  pack: PackId;
  recordId: string;
  label: Label;
  source: string;
  taskId?: string;
}

export interface TruthSink {
  learned(fact: Learned): Promise<boolean>;
}

/** Writes truths onto the decision log and reports each one (`decision.truth`: ids and source, no payload). */
export class DecisionTruth implements TruthSink {
  constructor(
    private readonly log: Pick<DecisionLog, "setTruth"> & Partial<Pick<DecisionLog, "read">>,
    private readonly options: { now?: () => Date; told?: (event: { taskId?: string; pack: PackId; recordId: string; source: string }) => Promise<void> } = {},
  ) {}

  /** The answer a record kept, or null when there is none (or the log cannot read). */
  async answerOf(pack: PackId, recordId: string): Promise<Record<string, unknown> | null> {
    return (await this.log.read?.(pack, recordId).catch(() => null))?.answer ?? null;
  }

  /** True when a record took the truth. A missing record, a log that cannot write: false, never a throw. */
  async learned(fact: Learned): Promise<boolean> {
    try {
      const truth: Truth = { label: fact.label, source: fact.source, at: (this.options.now?.() ?? new Date()).toISOString() };
      if (!(await this.log.setTruth(fact.pack, fact.recordId, truth))) return false;
      await this.options.told?.({ ...(fact.taskId ? { taskId: fact.taskId } : {}), pack: fact.pack, recordId: fact.recordId, source: fact.source }).catch(() => {});
      return true;
    } catch (error) {
      console.warn(`decision truth: could not keep ${fact.pack} ${fact.recordId}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }
}

// ---- triage_signals: what a person's correction, a one-tap reply or archive, or an approval with no edit says about the signals ----

/** The questions each field of the record answers. */
const QUESTIONS_OF: Record<TriageField, string[]> = { kind: ["kind"], size: ["size"], urgency: ["who", "what", "impact", "time", "demand"], risk: ["risk_prelim"], archive: ["archive"] };
/** The record fields a person may correct, and the question each one corrects (priority has no question of its own: it is five sub-scores). */
const EDIT_QUESTION: Partial<Record<NonNullable<TriageRecord["editedFields"]>[number], { question: string; value: (r: Partial<TriageRecord>) => string | undefined }>> = {
  kind: { question: "kind", value: (r) => r.kind },
  typeOfWork: { question: "type_of_work", value: (r) => r.typeOfWork },
  size: { question: "size", value: (r) => r.size },
  riskPrelim: { question: "risk_prelim", value: (r) => r.riskPrelim },
};

/** What the person corrected, as the questions' labels. A priority edit labels nothing: no single question said it. */
export function triageEditTruth(record: Partial<Pick<TriageRecord, "editedFields" | "kind" | "typeOfWork" | "size" | "riskPrelim">>): Label {
  const label: Label = {};
  for (const field of record.editedFields ?? []) {
    const edit = EDIT_QUESTION[field];
    const value = edit?.value(record);
    if (edit && value !== undefined) label[edit.question] = { choice: value };
  }
  return label;
}

/** An approval that left the signals alone confirms the ones the machine acted on (verdict `proceed`), each as it answered, except what the person corrected. */
export function triageConfirmTruth(classification: Pick<TaskClassification, "signals">, verdicts: Record<TriageField, Pick<FieldVerdict, "verdict">>, edited: ReadonlySet<string> = new Set()): Label {
  const label: Label = {};
  for (const [field, questions] of Object.entries(QUESTIONS_OF) as Array<[TriageField, string[]]>) {
    if (verdicts[field].verdict !== "proceed") continue;
    for (const q of questions) {
      const answer = classification.signals?.[q]?.answer;
      if (edited.has(q) || answer === undefined || answer === null) continue;
      label[q] = typeof answer === "string" ? { choice: answer } : typeof answer === "boolean" ? { value: answer } : { score: Math.round(answer) };
    }
  }
  return label;
}

/** The gate triage opened for a reply or an archive: approving it says the kind was a question (or the card should be archived), sending it back says it was not. */
export function triageOutcomeTruth(outcome: "conversation" | "archive", decision: "approved" | "sent_back"): Label {
  if (outcome === "conversation") return { kind: { choice: decision === "approved" ? "question" : ["bug", "feature", "task", "chore", "incident"] } };
  return { archive: { value: decision === "approved" } };
}
