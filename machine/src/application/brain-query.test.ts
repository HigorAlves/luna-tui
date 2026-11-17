import { describe, expect, it } from "vitest";

import type { Brain, BrainAnswer } from "./brain.ts";
import { MAX_BRAIN_ROWS, MAX_BRAIN_TEXT, brainQueryAnswerer, parseBrainRequest } from "./brain-query.ts";

function fakeBrain(answer: BrainAnswer = { rows: [{ card: "card:1", title: "Export CSV" }], note: null }, enabled = true) {
  const asked: Array<{ name: string; params?: Record<string, string | number> }> = [];
  const brain: Brain = {
    enabled,
    health: async () => ({ ok: true, version: "x", note: null }),
    load: async () => ({ entities: 0, commit: null }),
    unlink: async () => 0,
    reset: async () => {},
    query: async (name, params) => (asked.push({ name, params }), answer),
  };
  return { brain, asked };
}

const repoSlug = (path: string) => path.replace(/^\//, "");
const NOT_TOLD = { verdict: "skipped", problems: [], rows: [], note: "the brain is not told to this repository" };

describe("parseBrainRequest", () => {
  it("reads a name with string and number parameters, and none as no parameters", () => {
    expect(parseBrainRequest(JSON.stringify({ name: "search_cards", params: { q: "csv", n: 3 } }))).toEqual({ name: "search_cards", params: { q: "csv", n: 3 } });
    expect(parseBrainRequest(JSON.stringify({ name: "search_cards" }))).toEqual({ name: "search_cards", params: {} });
  });

  it("refuses anything the container could write wrongly: not JSON, no name, a long name, a parameter of another type, too many parameters", () => {
    for (const bad of ["{", "null", "[]", JSON.stringify({ name: 5 }), JSON.stringify({ name: "" }), JSON.stringify({ name: "x".repeat(81) }), JSON.stringify({ name: "a", params: [] }), JSON.stringify({ name: "a", params: { q: { deep: 1 } } }), JSON.stringify({ name: "a", params: { q: true } }), JSON.stringify({ name: "a", params: Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`k${i}`, "v"])) })]) {
      expect(parseBrainRequest(bad)).toBeNull();
    }
  });
});

describe("brainQueryAnswerer", () => {
  const request = { name: "search_cards_in_repo", params: { q: "csv" } };
  const runs = { name: "search_cards_in_repo", params: { q: "csv", repo: "repo:r" } };

  it("answers skipped, and asks nothing, unless the repository tells the brain", async () => {
    const { brain, asked } = fakeBrain();
    expect(await brainQueryAnswerer({ brain, tell: async () => false, repoSlug })("/r", request)).toEqual(NOT_TOLD);
    expect(asked).toEqual([]);
  });

  it("answers skipped when the brain is off, when the repository is unknown and when the setting cannot be read", async () => {
    const off = fakeBrain(undefined, false);
    expect(await brainQueryAnswerer({ brain: off.brain, tell: async () => true, repoSlug })("/r", request)).toEqual(NOT_TOLD);
    expect(off.asked).toEqual([]);
    const { brain, asked } = fakeBrain();
    expect(await brainQueryAnswerer({ brain, tell: async () => true, repoSlug })(null, request)).toEqual(NOT_TOLD);
    expect(await brainQueryAnswerer({ brain, tell: async () => { throw new Error("bad yaml"); }, repoSlug })("/r", request)).toEqual(NOT_TOLD);
    expect(asked).toEqual([]);
  });

  it("runs the named query and answers ok with its rows and note", async () => {
    const { brain, asked } = fakeBrain({ rows: [{ card: "card:1" }], note: "one match" });
    expect(await brainQueryAnswerer({ brain, tell: async (repo) => repo === "/r", repoSlug })("/r", request)).toEqual({ verdict: "ok", problems: [], rows: [{ card: "card:1" }], note: "one match" });
    expect(asked).toEqual([runs]);
  });

  it("refuses a name an agent may not run and a parameter the query does not declare, with the reason in problems", async () => {
    const { brain, asked } = fakeBrain();
    const answer = brainQueryAnswerer({ brain, tell: async () => true, repoSlug });
    expect(await answer("/r", { name: "precedents", params: { pack: "p", q: "x" } })).toMatchObject({ verdict: "refused", rows: [] });
    expect(await answer("/r", { name: "nope", params: {} })).toMatchObject({ verdict: "refused" });
    expect(await answer("/r", { name: "search_cards_in_repo", params: { q: "x", extra: "y" } })).toMatchObject({ verdict: "refused", problems: ["search_cards_in_repo has no parameter extra"] });
    expect(await answer("/r", { name: "search_cards_in_repo", params: {} })).toMatchObject({ verdict: "refused", problems: ["search_cards_in_repo needs q as a string"] });
    expect(asked).toEqual([]);
  });

  it("keeps at most the first MAX_BRAIN_ROWS rows and cuts every string to MAX_BRAIN_TEXT characters, leaving numbers and nulls", async () => {
    const rows = Array.from({ length: MAX_BRAIN_ROWS + 5 }, (_, i) => ({ id: `card:${i}`, text: "x".repeat(MAX_BRAIN_TEXT + 50), n: i, none: null }));
    const { brain } = fakeBrain({ rows, note: null });
    const answer = await brainQueryAnswerer({ brain, tell: async () => true, repoSlug })("/r", request);
    expect(answer.rows).toHaveLength(MAX_BRAIN_ROWS);
    expect(answer.rows[0]).toEqual({ id: "card:0", text: "x".repeat(MAX_BRAIN_TEXT), n: 0, none: null });
    expect(answer.rows[MAX_BRAIN_ROWS - 1]!.id).toBe(`card:${MAX_BRAIN_ROWS - 1}`);
  });

  it("answers skipped, not a throw, when the brain fails", async () => {
    const { brain } = fakeBrain();
    brain.query = async () => { throw new Error("down"); };
    expect(await brainQueryAnswerer({ brain, tell: async () => true, repoSlug })("/r", request)).toMatchObject({ verdict: "skipped", rows: [] });
  });
});

describe("brainQueryAnswerer, confined to the task's repository", () => {
  const ask = (brain: Brain, repoPath = "/mine") => (name: string, params: Record<string, string | number> = {}) => brainQueryAnswerer({ brain, tell: async () => true, repoSlug })(repoPath, { name, params });

  it("runs a repo query with the task's repository whatever the request names, or nothing", async () => {
    const { brain, asked } = fakeBrain();
    expect(await ask(brain)("cards_in_repo", { repo: "repo:other" })).toMatchObject({ verdict: "ok" });
    expect(await ask(brain)("cards_in_repo")).toMatchObject({ verdict: "ok" });
    expect(asked).toEqual([
      { name: "cards_in_repo", params: { repo: "repo:mine" } },
      { name: "cards_in_repo", params: { repo: "repo:mine" } },
    ]);
  });

  it("refuses a global search and the incidents with a sentence that lists the tool queries, and asks nothing", async () => {
    const { brain, asked } = fakeBrain();
    for (const name of ["search_cards", "open_incidents", "cards_for_ticket", "search_principles", "card_repo"]) {
      const answer = await ask(brain)(name, { q: "x", ticket: "t", card: "c" });
      expect(answer, name).toMatchObject({ verdict: "refused", rows: [] });
      expect(answer.problems[0], name).toContain("cards_in_repo");
    }
    expect(asked).toEqual([]);
  });

  it("answers a card of the task's repository and refuses one of another, or one it cannot place", async () => {
    const lookups: Array<Record<string, string | number> | undefined> = [];
    const brain = fakeBrain().brain;
    brain.query = async (name, params) => {
      if (name !== "card_repo") return { rows: [{ card: params!.card as string }], note: null };
      lookups.push(params);
      if (params!.card === "card:mine") return { rows: [{ repo: "repo:mine" }], note: null };
      if (params!.card === "card:theirs") return { rows: [{ repo: "repo:other" }], note: null };
      if (params!.card === "card:broken") throw new Error("down");
      return { rows: [], note: null };
    };
    expect(await ask(brain)("card_lookup", { card: "card:mine" })).toMatchObject({ verdict: "ok", rows: [{ card: "card:mine" }] });
    for (const card of ["card:theirs", "card:none", "card:broken"]) expect(await ask(brain)("card_lookup", { card }), card).toMatchObject({ verdict: "refused", rows: [] });
    expect(lookups).toHaveLength(4);
  });

  it("refuses a card lookup whose own check fails", async () => {
    const { brain, asked } = fakeBrain({ rows: [], note: "the brain did not answer" });
    expect(await ask(brain)("prs_for_card", { card: "card:1" })).toMatchObject({ verdict: "refused" });
    expect(asked.map((a) => a.name)).toEqual(["card_repo"]);
  });

  it("answers a component of the task's repository and refuses one of another", async () => {
    const { brain, asked } = fakeBrain();
    expect(await ask(brain)("cards_touching", { component: "component:mine/board" })).toMatchObject({ verdict: "ok" });
    expect(await ask(brain)("cards_touching", { component: "component:other/board" })).toMatchObject({ verdict: "refused" });
    expect(await ask(brain)("cards_touching", { component: "component:mine-2/board" })).toMatchObject({ verdict: "refused" });
    expect(asked).toEqual([{ name: "cards_touching", params: { component: "component:mine/board" } }]);
  });
});
