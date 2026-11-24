// Our questions in Jev's words and its answers in ours: yes/no is `noul` on the wire and comes
// back as P(yes); a rubric goes as an ordered list; a choice keeps its labels.
import type { QuestionSet } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import { fromDecide, fromJev, toDecide, toJev } from "./questions.ts";

const questions: QuestionSet = {
  kind: { type: "choice", instructions: "What kind?", criteria: { bug: "broken", feature: "new" } },
  ready: { type: "yesno", instructions: "Is it ready?", threshold: 0.6 },
  urgent: { type: "yesno", instructions: "Is it urgent?" },
  size: { type: "score", instructions: "How big?", rubric: { tiny: "a line", large: "a subsystem" } },
};

describe("the Jev questions", () => {
  it("sends a choice with its criteria, a yes/no as noul and a rubric in order", () => {
    expect(toJev(questions)).toEqual({
      kind: { type: "choice", instructions: "What kind?", criteria: { bug: "broken", feature: "new" } },
      ready: { type: "noul", instructions: "Is it ready?" },
      urgent: { type: "noul", instructions: "Is it urgent?" },
      size: { type: "score", instructions: "How big?", criteria: ["tiny: a line", "large: a subsystem"] },
    });
  });

  it("reads P(yes) against the question's threshold, 0.5 by default, and keeps each confidence", () => {
    const answers = {
      kind: { type: "choice", choice: "bug", confidence: 0.91, probabilities: { bug: 0.91, feature: 0.09 } },
      ready: { type: "noul", noul: 0.55 },
      urgent: { type: "noul", noul: 0.55 },
      size: { type: "score", score: 0.4, confidence: 0.7, legend: { 0: "tiny: a line", 1: "large: a subsystem" }, probabilities: { 0: 0.6, 1: 0.4 } },
    } as const;
    expect(fromJev(questions, answers)).toEqual({
      kind: { choice: "bug", confidence: 0.91 },
      ready: { value: false, p: 0.55 },
      urgent: { value: true, p: 0.55 },
      size: { score: 0.4, confidence: 0.7 },
    });
  });

  it("refuses an answer that is missing or of another type", () => {
    expect(() => fromJev({ ready: questions.ready! }, {})).toThrow(/ready/);
    expect(() => fromJev({ ready: questions.ready! }, { ready: { type: "choice" } })).toThrow(/ready/);
  });
});

describe("the AI SDK's decision questions (the Gateway)", () => {
  it("sends a choice with its criteria, a yes/no as boolean and a rubric in order", () => {
    expect(toDecide(questions)).toEqual({
      kind: { type: "choice", instructions: "What kind?", criteria: { bug: "broken", feature: "new" } },
      ready: { type: "boolean", instructions: "Is it ready?" },
      urgent: { type: "boolean", instructions: "Is it urgent?" },
      size: { type: "score", instructions: "How big?", criteria: ["tiny: a line", "large: a subsystem"] },
    });
  });

  it("reads a boolean's probability against the threshold, and a choice's or score's confidence from its distribution", () => {
    const answers = {
      kind: { type: "choice", choice: "bug", probabilities: { bug: 0.91, feature: 0.09 } },
      ready: { type: "boolean", probability: 0.55 },
      urgent: { type: "boolean", probability: 0.55 },
      size: { type: "score", score: 0.4, probabilities: { 0: 0.6, 1: 0.4 } },
    } as const;
    expect(fromDecide(questions, answers)).toEqual({
      kind: { choice: "bug", confidence: 0.91 },
      ready: { value: false, p: 0.55 },
      urgent: { value: true, p: 0.55 },
      size: { score: 0.4, confidence: 0.6 },
    });
  });

  it("prefers the confidence Jev reported over the one read from the distribution", () => {
    const answers = { kind: { type: "choice", choice: "bug", probabilities: { bug: 0.7, feature: 0.3 } }, size: { type: "score", score: 1, probabilities: { 0: 0.2, 1: 0.8 } } };
    expect(fromDecide({ kind: questions.kind!, size: questions.size! }, answers, { kind: 0.75, size: 0.85 })).toEqual({ kind: { choice: "bug", confidence: 0.75 }, size: { score: 1, confidence: 0.85 } });
  });

  it("gives no confidence (0) to an answer without a distribution, so nothing acts on it", () => {
    const answers = { kind: { type: "choice", choice: "bug" }, size: { type: "score", score: 1 } };
    expect(fromDecide({ kind: questions.kind!, size: questions.size! }, answers)).toEqual({ kind: { choice: "bug", confidence: 0 }, size: { score: 1, confidence: 0 } });
  });

  it("refuses an answer that is missing or of another type", () => {
    expect(() => fromDecide({ ready: questions.ready! }, {})).toThrow(/ready/);
    expect(() => fromDecide({ ready: questions.ready! }, { ready: { type: "choice" } })).toThrow(/ready.*boolean/);
  });
});
