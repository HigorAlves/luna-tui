import { brainNode, brainTime } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import { BrainError } from "../../application/brain.ts";
import { omnigraphBrain } from "./brain.ts";
import type { OmnigraphClient } from "./client.ts";

const tokens = { facts: "tok-facts", memories: "tok-memories", reader: "tok-reader" };
const repo = (n: number) => brainNode("Repo", { slug: `repo:${n}`, name: `r${n}` });

/** A client that records what it is asked and answers from `invoke`. */
function fake(invoke: OmnigraphClient["invoke"] = async () => ({ columns: [], rows: [] })) {
  const loads: Array<{ token: string; count: number; mode: string }> = [];
  const invoked: Array<{ token: string; name: string }> = [];
  const mutated: Array<{ token: string; query: string; params: Record<string, string | number> }> = [];
  const client: OmnigraphClient = {
    health: async () => ({ ok: true, version: "0.15.0" }),
    load: async (token, rows, mode) => {
      loads.push({ token, count: rows.length, mode });
      return { entities: rows.length, commit: "hb1" };
    },
    invoke: async (token, name, params) => {
      invoked.push({ token, name });
      return invoke(token, name, params);
    },
    mutate: async (token, query, params) => {
      mutated.push({ token, query, params });
      return { nodes: 0, edges: 2 };
    },
  };
  return { client, loads, invoked, mutated };
}

describe("omnigraphBrain.load", () => {
  it("makes one client load with the facts token by default, and the memories token when asked", async () => {
    const { client, loads } = fake();
    const brain = omnigraphBrain({ client, tokens });
    expect(brain.enabled).toBe(true);
    await expect(brain.load([repo(1), repo(2)])).resolves.toEqual({ entities: 2, commit: "hb1" });
    await brain.load([repo(1)], { mode: "append", actor: "memories" });
    expect(loads).toEqual([
      { token: "tok-facts", count: 2, mode: "merge" },
      { token: "tok-memories", count: 1, mode: "append" },
    ]);
  });

  it("throws too_large without a request when one type exceeds the limit", async () => {
    const { client, loads } = fake();
    const brain = omnigraphBrain({ client, tokens });
    const rows = Array.from({ length: 8_193 }, (_, n) => repo(n));
    const error = await brain.load(rows).catch((caught) => caught);
    expect(error).toBeInstanceOf(BrainError);
    expect(error).toMatchObject({ code: "too_large", effects: "none" });
    expect(loads).toEqual([]);
  });

  it("passes a server refusal on", async () => {
    const { client } = fake();
    client.load = async () => {
      throw new BrainError("exists", "conflict", 409);
    };
    await expect(omnigraphBrain({ client, tokens }).load([repo(1)], { mode: "append" })).rejects.toMatchObject({ code: "conflict", status: 409 });
  });
});

describe("omnigraphBrain.query", () => {
  it("reads with the reader token and gives every column a key, null when the server left it out", async () => {
    const { client, invoked } = fake(async () => ({ columns: ["card", "title", "actual_loc"], rows: [{ card: "card:1", title: "t" }] }));
    const answer = await omnigraphBrain({ client, tokens }).query("card_lookup", { card: "card:1" });
    expect(answer).toEqual({ rows: [{ card: "card:1", title: "t", actual_loc: null }], note: null });
    expect(invoked).toEqual([{ token: "tok-reader", name: "card_lookup" }]);
  });

  it("reads a zoneless timestamp as UTC", async () => {
    const { client } = fake(async () => ({ columns: ["opened_at", "title"], rows: [{ opened_at: "2026-01-02T03:04:05", title: "2026-01-02T03:04:05 is a title?" }] }));
    const answer = await omnigraphBrain({ client, tokens }).query("card_lookup", { card: "x" });
    expect(answer.rows[0]!.opened_at).toBe(brainTime("2026-01-02T03:04:05Z"));
    expect(answer.rows[0]!.title).toBe("2026-01-02T03:04:05 is a title?");
  });

  it("notes an empty result", async () => {
    const { client } = fake();
    const answer = await omnigraphBrain({ client, tokens }).query("card_lookup", { card: "x" });
    expect(answer.rows).toEqual([]);
    expect(answer.note).toBeTruthy();
  });

  it("answers a failed read with no rows and a note without the token, never a throw", async () => {
    const { client } = fake(async () => {
      throw new BrainError("forbidden for tok-reader", "forbidden", 403);
    });
    const answer = await omnigraphBrain({ client, tokens }).query("card_lookup", { card: "x" });
    expect(answer.rows).toEqual([]);
    expect(answer.note).toContain("forbidden");
    expect(answer.note).not.toContain("tok-reader");
    const odd = fake(async () => {
      throw new Error("boom tok-reader");
    });
    const second = await omnigraphBrain({ client: odd.client, tokens }).query("card_lookup", { card: "x" });
    expect(second.rows).toEqual([]);
    expect(second.note).not.toContain("tok-reader");
  });
});

describe("omnigraphBrain.health", () => {
  it("reports the server's version and never throws", async () => {
    const { client } = fake();
    await expect(omnigraphBrain({ client, tokens }).health()).resolves.toEqual({ ok: true, version: "0.15.0", note: null });
    client.health = async () => {
      throw new BrainError("omnigraph is unreachable", "unreachable");
    };
    await expect(omnigraphBrain({ client, tokens }).health()).resolves.toMatchObject({ ok: false, version: null, note: expect.stringContaining("unreachable") });
  });
});

describe("omnigraphBrain.unlink and reset", () => {
  it("removes an edge by its ends, with the slugs as parameters and the facts token", async () => {
    const { client, mutated } = fake();
    const brain = omnigraphBrain({ client, tokens });
    await expect(brain.unlink("CardForTicket", "card:1")).resolves.toBe(2);
    await brain.unlink("CardTouches", "card:1", "component:a/b");
    expect(mutated).toEqual([
      { token: "tok-facts", query: "query unlink($from: String) { delete CardForTicket where from = $from }", params: { from: "card:1" } },
      { token: "tok-facts", query: "query unlink($from: String, $to: String) { delete CardTouches where from = $from and to = $to }", params: { from: "card:1", to: "component:a/b" } },
    ]);
  });

  it("refuses an edge name that is not in the contracts, without a request", async () => {
    const { client, mutated } = fake();
    const brain = omnigraphBrain({ client, tokens });
    await expect(brain.unlink('X where from = "a" }' as never, "card:1")).rejects.toMatchObject({ code: "bad_request" });
    expect(mutated).toEqual([]);
  });

  it("empties the graph type by type, the most dependent first", async () => {
    const { client, mutated } = fake();
    await omnigraphBrain({ client, tokens }).reset();
    const types = mutated.map((call) => /delete (\w+) where slug != ""/.exec(call.query)?.[1]);
    expect([...types].sort()).toEqual(["Actor", "Answer", "Card", "Claim", "Component", "Control", "Incident", "Learning", "PR", "Person", "Principle", "Regime", "Repo", "Source", "Ticket", "Verdict"]);
    expect(types.indexOf("Principle")).toBeLessThan(types.indexOf("Repo"));
    expect(types.indexOf("Learning")).toBeLessThan(types.indexOf("Claim"));
    expect(types.indexOf("Claim")).toBeLessThan(types.indexOf("Source"));
    expect(types.indexOf("PR")).toBeLessThan(types.indexOf("Card"));
    expect(types.indexOf("Card")).toBeLessThan(types.indexOf("Repo"));
    expect(types.indexOf("Actor")).toBeLessThan(types.indexOf("Person"));
    expect(mutated.every((call) => call.token === "tok-facts")).toBe(true);
  });
});
