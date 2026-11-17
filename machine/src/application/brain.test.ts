import { describe, expect, it } from "vitest";

import { type Brain, type BrainAnswer, agentQuery, noBrain } from "./brain.ts";

/** A brain that records the queries it is asked. */
function spy() {
  const asked: Array<{ name: string; params?: Record<string, string | number> }> = [];
  const answer: BrainAnswer = { rows: [{ card: "card:1" }], note: null };
  const brain: Brain = {
    enabled: true,
    health: async () => ({ ok: true, version: "x", note: null }),
    load: async () => ({ entities: 0, commit: null }),
    unlink: async () => 0,
    remove: async () => 0,
    reset: async () => {},
    query: async (name, params) => {
      asked.push({ name, params });
      return answer;
    },
  };
  return { brain, asked, answer };
}

describe("noBrain", () => {
  it("is off and answers everything with nothing, without throwing", async () => {
    const brain = noBrain();
    expect(brain.enabled).toBe(false);
    await expect(brain.load([{ type: "Repo", data: { slug: "repo:a", name: "a" } }])).resolves.toEqual({ entities: 0, commit: null });
    await expect(brain.query("card_lookup", { card: "card:1" })).resolves.toEqual({ rows: [], note: "the brain is off" });
    await expect(brain.health()).resolves.toEqual({ ok: false, version: null, note: "the brain is off" });
    await expect(brain.unlink("CardInRepo", "card:1")).resolves.toBe(0);
    await expect(brain.reset()).resolves.toBeUndefined();
  });
});

describe("agentQuery", () => {
  it("runs a query listed for agents and passes the params through", async () => {
    const { brain, asked, answer } = spy();
    await expect(agentQuery(brain, "card_lookup", { card: "card:1" })).resolves.toBe(answer);
    expect(asked).toEqual([{ name: "card_lookup", params: { card: "card:1" } }]);
  });

  it("refuses an unknown name and a hygiene query, naming it, without asking the brain", async () => {
    const { brain, asked } = spy();
    const unknown = await agentQuery(brain, "drop_everything");
    expect(unknown.rows).toEqual([]);
    expect(unknown.note).toContain("drop_everything");
    const hygiene = await agentQuery(brain, "agents_without_owner");
    expect(hygiene.rows).toEqual([]);
    expect(hygiene.note).toContain("agents_without_owner");
    expect(asked).toEqual([]);
  });

  it("refuses an undeclared parameter and one of the wrong type without asking the brain", async () => {
    const { brain, asked } = spy();
    const extra = await agentQuery(brain, "card_lookup", { card: "card:1", other: "x" });
    expect(extra.rows).toEqual([]);
    expect(extra.note).toContain("other");
    const wrongString = await agentQuery(brain, "card_lookup", { card: 7 });
    expect(wrongString.note).toContain("card");
    const missing = await agentQuery(brain, "card_lookup");
    expect(missing.rows).toEqual([]);
    expect(asked).toEqual([]);
  });

  it("does not take a name from the prototype chain for a declared parameter", async () => {
    const { brain, asked } = spy();
    for (const key of ["constructor", "toString", "hasOwnProperty"]) {
      const answer = await agentQuery(brain, "card_lookup", { card: "card:1", [key]: "x" });
      expect(answer.note, key).toContain(key);
    }
    expect(asked).toEqual([]);
  });
});
