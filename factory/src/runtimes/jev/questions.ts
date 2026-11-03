// A decision pack's questions in Jev's words, and Jev's answers in the pack's: the one file that
// knows the wire formats, TypeSafe's (yes/no is `noul` and answers P(yes); a choice and a score
// carry a confidence) and the AI SDK's decision API that the Gateway speaks (yes/no is `boolean`
// and answers its probability; a choice and a score carry a distribution). A rubric is an ordered
// list in both. A change to either moves only this file.
import type { Question, QuestionSet } from "@hardness/contracts";
import { type ChoiceResponse, type NoulResponse, type Question as JevQuestion, type Questions, type ScoreResponse, choice, noul, score } from "@typesafe-ai/sdk";
import type { Experimental_DecisionQuestion as DecideQuestion } from "ai";

const WIRE = { choice: "choice", yesno: "noul", score: "score" } as const;
const DECIDE_WIRE = { choice: "choice", yesno: "boolean", score: "score" } as const;

/** A rubric as both wires take it: its levels in order, 0 for the first. */
const levels = (rubric: Record<string, string>): string[] => Object.entries(rubric).map(([level, text]) => `${level}: ${text}`);

function toQuestion(question: Question): JevQuestion {
  switch (question.type) {
    case "choice":
      return choice(question.instructions ?? null, question.criteria);
    case "yesno":
      return noul(question.instructions);
    case "score":
      // In rubric order: Jev scores a level by its index, 0 for the first.
      return score(question.instructions, levels(question.rubric));
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

function toDecideQuestion(question: Question): DecideQuestion {
  switch (question.type) {
    case "choice":
      return { type: "choice", instructions: question.instructions ?? null, criteria: question.criteria };
    case "yesno":
      return { type: "boolean", instructions: question.instructions };
    case "score":
      return { type: "score", instructions: question.instructions, criteria: levels(question.rubric) };
  }
}

/** The questions as the AI SDK's `experimental_decide` takes them, under the same names. */
export function toDecide(questions: QuestionSet): Record<string, DecideQuestion> {
  return Object.fromEntries(Object.entries(questions).map(([name, question]) => [name, toDecideQuestion(question)]));
}

/** How sure a distribution is: its most likely outcome's probability. None given, 0: an answer
 *  without one never clears a pack's confidence floor. */
const peak = (probabilities?: Record<string, number>): number => Math.max(0, ...Object.values(probabilities ?? {}));

/** One answer as the decision API gives it, whatever its type. */
export type DecideAnswer = { type: string; choice?: string; score?: number; probability?: number; probabilities?: Record<string, number> };

/** The decision API's answers as the pack's answer schema has them, as `fromJev` reads TypeSafe's:
 *  a boolean's probability is `p`; a choice's or a score's confidence is the one Jev reported
 *  (the Gateway passes TypeSafe's in its provider metadata), else its label's probability or its
 *  likeliest level's. Throws on a missing answer or one of another type. */
export function fromDecide(questions: QuestionSet, answers: Record<string, DecideAnswer>, reported: Record<string, number> = {}): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(questions).map(([name, question]) => {
      const answer = answers[name];
      if (answer?.type !== DECIDE_WIRE[question.type]) throw new Error(`${name}: answered ${answer?.type ?? "nothing"}, not ${DECIDE_WIRE[question.type]}`);
      switch (question.type) {
        case "choice":
          return [name, { choice: answer.choice, confidence: reported[name] ?? answer.probabilities?.[answer.choice ?? ""] ?? peak(answer.probabilities) }];
        case "yesno": {
          const p = answer.probability;
          return [name, { value: typeof p === "number" && p >= (question.threshold ?? 0.5), p }];
        }
        case "score":
          return [name, { score: answer.score, confidence: reported[name] ?? peak(answer.probabilities) }];
      }
    }),
  );
}
