import { describe, expect, it } from "vitest";

import { type Candidate, SHORTLIST, similar, similarity } from "./similarity.ts";

const NOW = new Date("2026-11-05T00:00:00Z");
const cand = (id: string, title: string, over: Partial<Candidate> = {}): Candidate => ({ id, kind: "open", title, text: "", repo: "o/a", closedAt: null, ...over });

describe("lexical similarity", () => {
  it("is the share of words two texts have in common (hand-computed)", () => {
    // {checkout, fails, paying} against {checkout, fails, payment}: 2 shared of 4 in all.
    expect(similarity("Checkout fails when paying", "Checkout fails on payment")).toBe(0.5);
    // {checkout, fails, paying} against {checkout, fails, paying, card}: 3 of 4.
    expect(similarity("Checkout fails when paying", "Checkout fails when paying with card")).toBe(0.75);
    expect(similarity("Checkout fails", "Payment page is slow")).toBe(0);
    expect(similarity("", "")).toBe(0);
  });
});

describe("the shortlist", () => {
  const card = { title: "Checkout fails when paying", text: "", repo: "o/a" };
  it("keeps the five nearest above the floor, nearest first", () => {
    const cands = [
      cand("a", "Checkout fails when paying with card"),
      cand("b", "Checkout fails on payment"),
      cand("c", "Payment page is slow"),
      ...Array.from({ length: 6 }, (_, i) => cand(`n${i}`, `Checkout fails when paying later${i}`)),
    ];
    const out = similar(card, cands, { now: NOW, lookbackDays: 90 });
    expect(out).toHaveLength(SHORTLIST);
    expect(out[0]).toMatchObject({ id: "a", score: 0.75 });
    expect(out.map((o) => o.id)).not.toContain("c");
  });
  it("leaves out a card closed before the lookback, and a backlog item of another repository", () => {
    const out = similar(
      card,
      [
        cand("old", "Checkout fails when paying", { kind: "closed", closedAt: new Date("2026-06-01T00:00:00Z") }),
        cand("recent", "Checkout fails when paying", { kind: "closed", closedAt: new Date("2026-10-01T00:00:00Z") }),
        cand("other", "Checkout fails when paying", { kind: "backlog", repo: "o/b" }),
        cand("same", "Checkout fails when paying", { kind: "backlog", repo: "o/a" }),
      ],
      { now: NOW, lookbackDays: 90 },
    );
    expect(out.map((o) => o.id).sort()).toEqual(["recent", "same"]);
  });
  it("reads a bounded amount of a stranger's text", () => {
    const huge = "word ".repeat(100_000);
    expect(similar({ title: "x", text: huge, repo: null }, [cand("a", "x", { text: huge })], { now: NOW, lookbackDays: 90 })).toHaveLength(1);
  });
});
