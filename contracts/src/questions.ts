// The questions a decision pack asks about its input, in no runtime's words: each runtime maps
// them to its SDK (Jev's in factory/src/runtimes/jev/questions.ts). The answer schema is derived
// here, beside them, because the machine ingests the answer and needs its shape. See RFC 0002.
import { z } from "zod";

export type Question =
  /** One label of `criteria` (label → what it means), with how sure the model is. */
  | { type: "choice"; instructions?: string; criteria: Record<string, string> }
  /** Yes or no: `p` is P(yes), and `value` is `p >= threshold` (0.5 when unset). */
  | { type: "yesno"; instructions: string; threshold?: number }
  /** A place on the rubric (levels in order, at least two): 0 is the first, fractional between levels. */
  | { type: "score"; instructions: string; rubric: Record<string, string> };

/** Questions by the name their answer is keyed by. */
export type QuestionSet = Record<string, Question>;

const probability = z.number().min(0).max(1);

function answerOf(name: string, question: Question): z.ZodObject {
  switch (question.type) {
    case "choice": {
      const labels = Object.keys(question.criteria);
      if (labels.length === 0) throw new Error(`question ${name}: a choice needs at least one label`);
      return z.object({ choice: z.enum(labels as [string, ...string[]]), confidence: probability });
    }
    case "yesno":
      return z.object({ value: z.boolean(), p: probability });
    case "score": {
      const levels = Object.keys(question.rubric).length;
      if (levels < 2) throw new Error(`question ${name}: a score needs at least two rubric levels`);
      return z.object({ score: z.number().min(0).max(levels - 1), confidence: probability });
    }
  }
}

/** The answer a decision pack gives: one entry per question, keyed by its name. */
export function answerSchema(questions: QuestionSet): z.ZodObject {
  return z.object(Object.fromEntries(Object.entries(questions).map(([name, question]) => [name, answerOf(name, question)])));
}

/** Where an answer's confidence lands: acted on, acted on and shown as flagged, or a person decides. */
export type Verdict = "proceed" | "flag" | "ask";
export interface ConfidencePolicy {
  proceed: number;
  flag: number;
}
/** One bar per question, by the question's name. */
export type DecisionPolicy = Record<string, ConfidencePolicy>;
/** A repo's own bars, question by question; a bar left out keeps the pack's. */
export type DecisionOverrides = Record<string, Partial<ConfidencePolicy>>;

export const ConfidencePolicySchema = z.object({ proceed: z.number().min(0).max(1), flag: z.number().min(0).max(1) }).partial();

/** How sure an answer is: a yes/no's confidence is its distance from a coin toss. */
export function confidenceOf(question: Question, answer: unknown): number {
  const a = answer as Record<string, number>;
  return question.type === "yesno" ? Math.max(a.p!, 1 - a.p!) : a.confidence!;
}

export function verdictOf(confidence: number, policy: ConfidencePolicy): Verdict {
  if (confidence >= policy.proceed) return "proceed";
  if (confidence >= policy.flag) return "flag";
  return "ask";
}

const WORST: Record<Verdict, number> = { proceed: 0, flag: 1, ask: 2 };

/** Each question's verdict against its bar (the pack's, then the repo's override), the worst of them
 *  as `overall`, and the names of the questions short of `proceed`. */
export function applyPolicy(
  pack: { questions: QuestionSet; policy: DecisionPolicy },
  answer: Record<string, unknown>,
  overrides: DecisionOverrides = {},
): { verdicts: Record<string, Verdict>; overall: Verdict; below: string[] } {
  const verdicts: Record<string, Verdict> = {};
  const below: string[] = [];
  let overall: Verdict = "proceed";
  for (const [name, question] of Object.entries(pack.questions)) {
    const policy = { ...pack.policy[name], ...overrides[name] } as ConfidencePolicy;
    const v = verdictOf(confidenceOf(question, answer[name]), policy);
    verdicts[name] = v;
    if (v !== "proceed") below.push(name);
    if (WORST[v] > WORST[overall]) overall = v;
  }
  return { verdicts, overall, below };
}

/** The same bar for every question: what a pack declares when it has no reason to differ. */
export const samePolicy = (questions: QuestionSet, policy: ConfidencePolicy): DecisionPolicy => Object.fromEntries(Object.keys(questions).map((name) => [name, policy]));

/** The lowest `proceed` bar of a policy: what a one-line summary calls "below". */
export const lowestBar = (policy: DecisionPolicy): number => Math.min(...Object.values(policy).map((p) => p.proceed));
