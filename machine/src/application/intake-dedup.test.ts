import { describe, expect, it } from "vitest";

import type { Candidate } from "../domain/similarity.ts";
import { type DedupAnswer, intakeDedup, outcomeOf } from "./intake-dedup.ts";

const near = (id: string, score = 0.8) => ({ id, kind: "open" as const, score });
const ans = (...slots: Array<[string, number]>): DedupAnswer => Object.fromEntries(slots.map(([choice, confidence], i) => [`slot${i + 1}`, { choice, confidence }])) as DedupAnswer;
const T = { duplicate: 0.9, related: 0.7, askBelow: 0.7 };

describe("the outcome of a judgement", () => {
  const list = [near("a"), near("b"), near("c")];
  it("a confident same is a duplicate", () => {
    expect(outcomeOf(list, ans(["same", 0.95], ["different", 0.9]), T)).toEqual({ duplicate: near("a"), related: [], ask: [] });
  });
  it("the most confident same wins, and a tie goes to the nearer slot", () => {
    expect(outcomeOf(list, ans(["same", 0.92], ["same", 0.97]), T).duplicate?.id).toBe("b");
    expect(outcomeOf(list, ans(["same", 0.95], ["same", 0.95]), T).duplicate?.id).toBe("a");
  });
  it("a related, or a same short of the duplicate bar but past the related bar, links the cards", () => {
    expect(outcomeOf(list, ans(["related", 0.8], ["same", 0.8], ["different", 0.99]), T)).toEqual({ duplicate: null, related: [near("a"), near("b")], ask: [] });
  });
  it("a same or related under the asking bar asks a person with the candidates; a doubtful different does not", () => {
    expect(outcomeOf(list, ans(["same", 0.6], ["related", 0.5], ["different", 0.4]), T)).toEqual({ duplicate: null, related: [], ask: [near("a"), near("b")] });
  });
  it("reads only the slots the shortlist has", () => {
    expect(outcomeOf([near("a")], ans(["different", 0.9], ["same", 0.99]), T)).toEqual({ duplicate: null, related: [], ask: [] });
  });
});

describe("the call", () => {
  const cands: Candidate[] = [{ id: "x", kind: "open", title: "Checkout fails when paying with card", text: "<b>details</b>\nmore", repo: "o/a", closedAt: null }];
  const card = { title: "Checkout fails when paying", text: "it breaks", repo: "o/a" };
  it("asks one question with the flattened shortlist, and reads the answer", async () => {
    const seen: unknown[] = [];
    const out = await intakeDedup({ decide: async (ctx) => (seen.push(ctx), ans(["same", 0.95])) }, card, cands, { now: new Date("2026-11-05T00:00:00Z") });
    expect(out.duplicate?.id).toBe("x");
    expect(seen).toHaveLength(1);
    expect(JSON.stringify(seen[0])).not.toContain("<b>");
    expect(JSON.stringify(seen[0])).not.toContain("\\n");
  });
  it("makes no call when nothing is similar, and none of its outcomes when the call fails", async () => {
    let calls = 0;
    const decide = async () => (calls++, ans(["same", 1]));
    expect(await intakeDedup({ decide }, { title: "Unrelated zebra", text: "", repo: "o/a" }, cands, { now: new Date() })).toEqual({ duplicate: null, related: [], ask: [] });
    expect(calls).toBe(0);
    expect(await intakeDedup({ decide: async () => { throw new Error("down"); } }, card, cands, { now: new Date() })).toEqual({ duplicate: null, related: [], ask: [] });
  });
});
