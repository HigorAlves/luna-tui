import { describe, expect, it } from "vitest";

import { type ConversationAnswers, conversationScore } from "./conversation-score.ts";

const sub = (score: number, confidence = 1) => ({ score, confidence });
const flag = (value: boolean, p = 0.9) => ({ value, p });
const answers = (over: Partial<ConversationAnswers> = {}): ConversationAnswers => ({
  kind: { choice: "bug", confidence: 0.9 },
  needs_reply: flag(true),
  production_down: flag(false, 0.1),
  data_loss: flag(false, 0.1),
  security: flag(false, 0.1),
  who: sub(0), what: sub(0), impact: sub(0), time: sub(0), demand: sub(0),
  ...over,
});
const CONFIG = { confidence: 0.7 };

describe("conversationScore", () => {
  it("maps 0..2 to 1..3 and weighs with the defaults: all lowest is 3+3+2+2+1 = 11, a P3", () => {
    const r = conversationScore(answers(), CONFIG);
    expect(r.total).toBe(11);
    expect(r.priority).toBe("P3");
    expect(r.subScores.who).toEqual({ score: 1, confidence: 1 });
    expect(r.knockOut).toBeNull();
  });
  it("is 3*3 + 2*3 + 2*2 + 1*2 + 1*1 = 22 for 2,1,1,0,0: a P1 at the P1 band", () => {
    const r = conversationScore(answers({ who: sub(2), what: sub(1), impact: sub(1) }), CONFIG);
    expect(r.total).toBe(22);
    expect(r.priority).toBe("P1");
  });
  it("is 33 for every score at 2: a P0", () => {
    const r = conversationScore(answers({ who: sub(2), what: sub(2), impact: sub(2), time: sub(2), demand: sub(2) }), CONFIG);
    expect(r.total).toBe(33);
    expect(r.priority).toBe("P0");
  });
  it("pulls an unsure score toward 2: confidence 0.5 on a 3 reads 2.5 (27.5 over eleven weights, a P1)", () => {
    const r = conversationScore(answers({ who: sub(2, 0.5), what: sub(2, 0.5), impact: sub(2, 0.5), time: sub(2, 0.5), demand: sub(2, 0.5) }), CONFIG);
    expect(r.total).toBe(27.5);
    expect(r.priority).toBe("P1");
  });
  it("uses the repository's weights and bands", () => {
    const r = conversationScore(answers(), { ...CONFIG, scoring: { weights: { who: 1, what: 1, impact: 1, time: 1, demand: 1 }, bands: { P0: 9, P1: 7, P2: 5 } } });
    expect(r.total).toBe(5);
    expect(r.priority).toBe("P2");
  });
  it.each(["production_down", "data_loss", "security"] as const)("a %s flag at 0.7 or more is P0 whatever the scores say", (name) => {
    const r = conversationScore(answers({ [name]: flag(true, 0.7) }), CONFIG);
    expect(r.priority).toBe("P0");
    expect(r.knockOut).toBe(name);
  });
  it("does not count a flag below 0.7, or a no", () => {
    expect(conversationScore(answers({ security: flag(true, 0.69) }), CONFIG).knockOut).toBeNull();
    expect(conversationScore(answers({ security: flag(false, 0.99) }), CONFIG).knockOut).toBeNull();
  });
  it("asks when the kind or the need for a reply is under the confidence", () => {
    expect(conversationScore(answers({ kind: { choice: "bug", confidence: 0.69 } }), CONFIG).verdict).toBe("ask");
    expect(conversationScore(answers({ needs_reply: flag(true, 0.6) }), CONFIG).verdict).toBe("ask");
    expect(conversationScore(answers({ needs_reply: flag(false, 0.2) }), CONFIG).verdict).toBe("ok");
    expect(conversationScore(answers(), CONFIG).verdict).toBe("ok");
  });
  it("reads a sure yes on needs_reply only", () => {
    expect(conversationScore(answers(), CONFIG).needsReply).toBe(true);
    expect(conversationScore(answers({ needs_reply: flag(true, 0.6) }), CONFIG).needsReply).toBe(false);
    expect(conversationScore(answers({ needs_reply: flag(false, 0.9) }), CONFIG).needsReply).toBe(false);
  });
});
