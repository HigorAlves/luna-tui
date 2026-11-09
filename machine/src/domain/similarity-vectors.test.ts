import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { type Candidate, SHORTLIST, similar, similarWithVectors } from "./similarity.ts";

const NOW = new Date("2026-11-05T00:00:00Z");
const O = { now: NOW, lookbackDays: 90 };
const card = { title: "Checkout fails when paying with card", text: "payment form throws", repo: "o/a" };
const c = (id: string, title: string, over: Partial<Candidate> = {}): Candidate => ({ id, kind: "open", title, text: "", repo: "o/a", closedAt: null, ...over });

describe("the lexical shortlist joined with memory's vectors", () => {
  const pool = [c("lex1", "Checkout fails when paying with card"), c("lex2", "Payment form throws on checkout"), c("vec1", "Billing screen crashes"), c("vec2", "Invoice export is slow")];

  it("is the lexical shortlist when memory names nothing", () => {
    expect(similarWithVectors(card, pool, [], O)).toEqual(similar(card, pool, O));
  });

  it("keeps every lexical hit first, in its ranking, and fills the free slots with the vector hits in their order", () => {
    const lexical = similar(card, pool, O);
    const out = similarWithVectors(card, pool, ["vec2", "vec1", "lex2"], O);
    expect(out.slice(0, lexical.length)).toEqual(lexical);
    expect(out.map((n) => n.id)).toEqual([...lexical.map((n) => n.id), "vec2", "vec1"]);
  });

  it("never passes five slots and never drops a lexical hit for a vector one", () => {
    const many = Array.from({ length: 8 }, (_, i) => c(`lex${i}`, `Checkout fails when paying with card number ${i}`));
    const out = similarWithVectors(card, [...many, c("vec", "Billing screen crashes")], ["vec"], O);
    expect(out).toHaveLength(SHORTLIST);
    expect(out.map((n) => n.id)).toEqual(similar(card, many, O).map((n) => n.id));
  });

  it("never adds a card that is not among the candidates (the ones its reporter could see)", () => {
    const out = similarWithVectors(card, pool, ["someone-elses-card", "vec1"], O);
    expect(out.map((n) => n.id)).not.toContain("someone-elses-card");
    expect(out.map((n) => n.id)).toContain("vec1");
  });

  it("applies the lookback to a closed vector hit and the repository to a backlog one", () => {
    const old = c("old", "Billing screen crashes", { kind: "closed", closedAt: new Date("2025-01-01T00:00:00Z") });
    const recent = c("recent", "Billing screen crashes again", { kind: "closed", closedAt: new Date("2026-10-30T00:00:00Z") });
    const elsewhere = c("elsewhere", "Billing screen", { kind: "backlog", repo: "o/b" });
    const out = similarWithVectors(card, [old, recent, elsewhere], ["old", "recent", "elsewhere"], O);
    expect(out.map((n) => n.id)).toEqual(["recent"]);
  });

  it("lists a vector hit once, even when it is also lexical", () => {
    const out = similarWithVectors(card, pool, ["lex1", "lex1", "vec1", "vec1"], O);
    expect(new Set(out.map((n) => n.id)).size).toBe(out.length);
  });
});

describe("over the labelled intake_dedup cases", () => {
  const dir = fileURLToPath(new URL("../../../evals/intake_dedup/cases/", import.meta.url));
  const cases = readdirSync(dir).flatMap((name) => {
    const stage = JSON.parse(readFileSync(`${dir}${name}/stage.json`, "utf8")) as { context?: { dedup?: { title: string; text: string; candidates: Array<{ slot: number; kind: "open" | "closed" | "backlog"; title: string; summary: string }> } } };
    const dedup = stage.context?.dedup;
    return dedup ? [{ name, dedup }] : [];
  });

  it("has labelled pairs to read", () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  for (const { name, dedup } of cases) {
    it(`${name}: the union never drops a lexical hit and never adds a card outside the candidates`, () => {
      const candidates: Candidate[] = dedup.candidates.map((x) => ({ id: `slot${x.slot}`, kind: "open" as const, title: x.title, text: x.summary, repo: "r", closedAt: null }));
      const subject = { title: dedup.title, text: dedup.text, repo: "r" };
      const lexical = similar(subject, candidates, O);
      const vectors = [...candidates.map((x) => x.id).reverse(), "foreign-card"];
      const out = similarWithVectors(subject, candidates, vectors, O);
      expect(out.slice(0, lexical.length)).toEqual(lexical);
      expect(out.every((n) => candidates.some((x) => x.id === n.id))).toBe(true);
      expect(out.length).toBeLessThanOrEqual(SHORTLIST);
      expect(out.length).toBeGreaterThanOrEqual(lexical.length);
    });
  }
});
