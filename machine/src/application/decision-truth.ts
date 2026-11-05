// Ground truth for decision packs: when a later fact settles what a decision should have said, the
// machine writes that label onto the decision's record (RFC 0005 wave 7). Each derivation below is
// one fact to one label, in the answer's shape: a scalar is what the question's answer should have
// been (`equals`), an array the labels it may have been (`oneOf`) for a fact that only rules one out.
// A decision's record id travels on its answer as a symbol-keyed property: it survives the spreads
// and hand-offs between a decide function and its stage, and never reaches JSON.
import type { DecisionPack, DecisionTruth as Truth, PackId } from "@hardness/contracts";

import type { DecisionLog } from "./decision-log.ts";

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
export const evidenceFormatTruth = (format: string): Label => ({ format: { choice: format } });
/** `testRewritten`: the slice went red again after the judged red, because the test was changed. */
export const redCheckTruth = (testRewritten: boolean): Label => ({ right_reason: { value: !testRewritten } });
export const worthLearningTruth = (approved: boolean): Label => ({ worth: { value: approved } });
export const eventClassTruth = (furtherActivity: boolean): Label => ({ event: { choice: furtherActivity ? "comment" : "noise" } });
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
