// A decision pack's questions in Jev's words, and Jev's answers in the pack's: the one file that
// knows the wire format (yes/no is `noul` and answers P(yes); a rubric is an ordered list), so a
// change to it moves only this file.
import type { Question, QuestionSet } from "@hardness/contracts";
import { type ChoiceResponse, type NoulResponse, type Question as JevQuestion, type Questions, type ScoreResponse, choice, noul, score } from "@typesafe-ai/sdk";

const WIRE = { choice: "choice", yesno: "noul", score: "score" } as const;

function toQuestion(question: Question): JevQuestion {
  switch (question.type) {
    case "choice":
      return choice(question.instructions ?? null, question.criteria);
    case "yesno":
      return noul(question.instructions);
    case "score":
      // In rubric order: Jev scores a level by its index, 0 for the first.
      return score(question.instructions, Object.entries(question.rubric).map(([level, text]) => `${level}: ${text}`));
  }
}

/** The questions as `systemOne` takes them, under the same names. */
export function toJev(questions: QuestionSet): Questions {
  return Object.fromEntries(Object.entries(questions).map(([name, question]) => [name, toQuestion(question)]));
}

/** Jev's answers as the pack's answer schema has them; throws on a missing answer or one of another type. */
export function fromJev(questions: QuestionSet, answers: Record<string, { type: string }>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(questions).map(([name, question]) => {
      const answer = answers[name];
      if (answer?.type !== WIRE[question.type]) throw new Error(`${name}: answered ${answer?.type ?? "nothing"}, not ${WIRE[question.type]}`);
      switch (question.type) {
        case "choice": {
          const { choice: label, confidence } = answer as ChoiceResponse;
          return [name, { choice: label, confidence }];
        }
        case "yesno": {
          const p = (answer as NoulResponse).noul;
          return [name, { value: p >= (question.threshold ?? 0.5), p }];
        }
        case "score": {
          const { score: value, confidence } = answer as ScoreResponse;
          return [name, { score: value, confidence }];
        }
      }
    }),
  );
}
