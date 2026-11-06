import { describe, expect, it } from "vitest";

import { type DepFact, holdText, schedulable } from "./stack.ts";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const fact = (n: number, over: Partial<DepFact> = {}): DepFact => ({ id: id(n), repoPath: "/r/app", branch: `task/${n}`, state: "awaiting_approval", archiveReason: null, hasOpenPr: false, merged: false, base: null, mergedInto: null, ...over });
const facts = (...all: DepFact[]) => new Map(all.map((f) => [f.id, f]));
const me = (...deps: number[]) => ({ id: id(99), repoPath: "/r/app", dependsOn: deps.map(id) });
const rule = { maxDepth: 8 };

describe("schedulable", () => {
  it("is ok with no base when every dependency merged", () => {
    expect(schedulable(me(1), facts(fact(1, { state: "closed", merged: true })), rule)).toEqual({ ok: true, base: null });
  });

  it("takes the one open dependency with a PR as its base", () => {
    expect(schedulable(me(1), facts(fact(1, { hasOpenPr: true, state: "ci_watch" })), rule)).toEqual({ ok: true, base: { card: id(1), branch: "task/1" } });
  });

  it("waits for a dependency that is not terminal and has no open PR, and names it", () => {
    expect(schedulable(me(1, 2), facts(fact(1, { state: "closed", merged: true }), fact(2)), rule)).toEqual({ ok: false, reason: "waiting", waitingOn: [id(2)] });
  });

  it("stops for an archived dependency, unless it was merged into a card, which is read in its place", () => {
    expect(schedulable(me(1), facts(fact(1, { state: "archived", archiveReason: "rejected" })), rule)).toEqual({ ok: false, reason: "dependency_archived", waitingOn: [id(1)] });
    const into = facts(fact(1, { state: "closed", mergedInto: id(2) }), fact(2, { hasOpenPr: true }));
    expect(schedulable(me(1), into, rule)).toEqual({ ok: true, base: { card: id(2), branch: "task/2" } });
  });

  it("says missing for a dependency that is no card, and for a merged-into card that is no card", () => {
    expect(schedulable(me(7), facts(), rule)).toEqual({ ok: false, reason: "missing", waitingOn: [id(7)] });
    expect(schedulable(me(1), facts(fact(1, { state: "closed", mergedInto: id(8) })), rule)).toEqual({ ok: false, reason: "missing", waitingOn: [id(8)] });
  });

  it("never bases on a dependency of another repository or with no branch", () => {
    expect(schedulable(me(1), facts(fact(1, { hasOpenPr: true, repoPath: "/r/other" })), rule)).toEqual({ ok: true, base: null });
    expect(schedulable(me(1), facts(fact(1, { hasOpenPr: true, branch: null })), rule)).toEqual({ ok: true, base: null });
  });

  it("with several open dependencies takes the one whose stack holds the others", () => {
    const set = facts(fact(1, { hasOpenPr: true }), fact(2, { hasOpenPr: true, base: { card: id(1), branch: "task/1" } }));
    expect(schedulable(me(1, 2), set, rule)).toEqual({ ok: true, base: { card: id(2), branch: "task/2" } });
  });

  it("is diverging when no open dependency holds the others", () => {
    const set = facts(fact(1, { hasOpenPr: true }), fact(2, { hasOpenPr: true }));
    expect(schedulable(me(1, 2), set, rule)).toEqual({ ok: false, reason: "diverging", waitingOn: [id(1), id(2)] });
  });

  it("is too deep when the chain with this card is longer than maxDepth", () => {
    const set = facts(fact(1, { hasOpenPr: true }), fact(2, { hasOpenPr: true, base: { card: id(1), branch: "task/1" } }), fact(3, { hasOpenPr: true, base: { card: id(2), branch: "task/2" } }));
    expect(schedulable(me(3), set, { maxDepth: 3 })).toEqual({ ok: false, reason: "too_deep", waitingOn: [id(3)] });
    expect(schedulable(me(3), set, { maxDepth: 4 })).toMatchObject({ ok: true });
  });

  it("is a cycle when the card is its own dependency or sits in the chain of its base", () => {
    expect(schedulable({ id: id(1), repoPath: "/r/app", dependsOn: [id(1)] }, facts(fact(1)), rule)).toMatchObject({ ok: false, reason: "cycle" });
    const set = facts(fact(1, { hasOpenPr: true, base: { card: id(99), branch: "task/99" } }));
    expect(schedulable(me(1), set, rule)).toMatchObject({ ok: false, reason: "cycle" });
  });

  it("ends on a chain that loops among other cards", () => {
    const set = facts(fact(1, { hasOpenPr: true, base: { card: id(2), branch: "x" } }), fact(2, { hasOpenPr: true, base: { card: id(1), branch: "y" } }));
    expect(schedulable(me(1), set, rule)).toMatchObject({ ok: false, reason: "cycle" });
  });
});

describe("holdText", () => {
  const short = (n: number) => id(n).slice(0, 8);
  it("says in words a person can read what a held card waits for, and that a stopped parent is with a person", () => {
    const set = facts(fact(1), fact(2, { state: "escalated" }));
    expect(holdText({ reason: "waiting", waitingOn: [id(1), id(2)] }, set)).toBe(`waiting for ${short(1)} to have an open PR; waiting for ${short(2)}, which is stopped with a person`);
  });

  it("has a sentence for every other reason", () => {
    const set = facts(fact(1, { state: "archived", archiveReason: "rejected" }));
    expect(holdText({ reason: "dependency_archived", waitingOn: [id(1)] }, set)).toBe(`${short(1)} was archived (rejected); a person decides`);
    expect(holdText({ reason: "missing", waitingOn: [id(7)] }, set)).toBe(`${short(7)} is not a card`);
    expect(holdText({ reason: "diverging", waitingOn: [id(1), id(2)] }, set)).toMatch(/all but one has merged/);
    expect(holdText({ reason: "too_deep", waitingOn: [id(1)] }, set)).toMatch(/deeper than/);
    expect(holdText({ reason: "cycle", waitingOn: [id(1)] }, set)).toMatch(/lead back/);
  });
});
