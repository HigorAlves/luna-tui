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
