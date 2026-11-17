import { type BrainRow, brainEdge, brainNode, brainTime } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import { BRAIN_LOAD_ORDER, brainBatches } from "./batches.ts";

const card = (n: number): BrainRow =>
  brainNode("Card", { slug: `card:${n}`, title: `t${n}`, state: "open", route: "r", opened_at: brainTime("2026-01-01T00:00:00Z") });
const inRepo = (n: number): BrainRow => brainEdge("CardInRepo", `card:${n}`, "repo:a");
const key = (row: BrainRow) => ("type" in row ? String(row.data.slug) : `${row.from}>${row.to}`);

describe("brainBatches", () => {
  it("gives no batch for no rows and one batch for a few", () => {
    expect(brainBatches([])).toEqual([]);
    const rows = [card(1), inRepo(1), card(2)];
    expect(brainBatches(rows)).toEqual([rows]);
  });

  it("splits 20,000 cards with an edge each into three batches, each card with its edge and the order kept", () => {
    const rows: BrainRow[] = [];
    for (let n = 0; n < 20_000; n++) rows.push(card(n), inRepo(n));
    const batches = brainBatches(rows);
    expect(batches.map((batch) => batch.length)).toEqual([16_384, 16_384, 7_232]);
    expect(batches.flat().map(key)).toEqual(rows.map(key));
    for (const batch of batches) {
      const cards = new Set(batch.filter((row) => "type" in row).map(key));
      const edges = batch.filter((row) => "edge" in row);
      expect(edges.every((edge) => "edge" in edge && cards.has(edge.from))).toBe(true);
      expect(cards.size).toBe(edges.length);
    }
  });

  // Its node is already in the graph, so it goes after every node of this run: one of them may be what it points at.
  it("keeps an edge whose node is not among the rows as its own unit, after the nodes", () => {
    const rows = [card(1), inRepo(1), inRepo(99), card(2)];
    expect(brainBatches(rows, { perKey: 1 }).map((batch) => batch.map(key))).toEqual([
      ["card:1", "card:1>repo:a"],
      ["card:2", "card:99>repo:a"],
    ]);
  });

  it("splits by bytes", () => {
    const rows = [card(1), card(2), card(3)];
    const one = Buffer.byteLength(`${JSON.stringify(rows[0])}\n`);
    expect(brainBatches(rows, { bytes: one * 2 + 10 }).map((batch) => batch.length)).toEqual([2, 1]);
  });

  it("throws when one unit is larger than a limit", () => {
    expect(() => brainBatches([card(1), inRepo(1)], { bytes: 10 })).toThrow(/too large/);
    const fan: BrainRow[] = [brainNode("Card", { slug: "card:1", title: "t", state: "open", route: "r", opened_at: brainTime("2026-01-01T00:00:00Z") })];
    for (let n = 0; n < 3; n++) fan.push(brainEdge("CardTouches", "card:1", `component:${n}`));
    expect(() => brainBatches(fan, { perKey: 2 })).toThrow(/too large/);
  });
  it("loads a node after every node its edges point at, whatever order the caller gave", () => {
    const rows: BrainRow[] = [
      brainNode("PR", { slug: "pr:o/r#1", number: 1, title: "t", state: "open", url: "https://example.test/1" }),
      brainEdge("PrForCard", "pr:o/r#1", "card:1"),
      brainNode("Card", { slug: "card:1", title: "t", state: "open", route: "feature", opened_at: "2026-11-16T12:00:00.000Z" }),
      brainEdge("CardInRepo", "card:1", "repo:r"),
      brainEdge("CardForTicket", "card:1", "ticket:jira/A-1"),
      brainNode("Ticket", { slug: "ticket:jira/A-1", tracker: "jira", key: "A-1", title: "t", url: null }),
      brainNode("Repo", { slug: "repo:r", name: "r" }),
    ];
    const [only, ...rest] = brainBatches(rows);
    expect(rest).toEqual([]);
    const at = (slug: string): number => only!.findIndex((row) => "type" in row && row.data.slug === slug);
    expect(at("repo:r")).toBeLessThan(at("card:1"));
    expect(at("ticket:jira/A-1")).toBeLessThan(at("card:1"));
    expect(at("card:1")).toBeLessThan(at("pr:o/r#1"));
    // each node still travels with its own edges
    expect(only![at("card:1") + 1]).toEqual(brainEdge("CardInRepo", "card:1", "repo:r"));
    expect(only![at("pr:o/r#1") + 1]).toEqual(brainEdge("PrForCard", "pr:o/r#1", "card:1"));
  });
  it("orders the node types so each comes after what its edges point at", () => {
    const at = (type: string): number => BRAIN_LOAD_ORDER.indexOf(type);
    expect([...BRAIN_LOAD_ORDER].sort()).toEqual(["Actor", "Card", "Claim", "Component", "Learning", "PR", "Person", "Principle", "Repo", "Source", "Ticket", "Verdict"]);
    for (const [from, to] of [["Card", "Repo"], ["Card", "Ticket"], ["Card", "Component"], ["Component", "Repo"], ["PR", "Card"], ["PR", "Person"], ["Actor", "Person"], ["Verdict", "Card"], ["Source", "Card"], ["Claim", "Source"], ["Claim", "Person"], ["Claim", "Repo"], ["Learning", "Claim"], ["Learning", "Repo"]]) {
      expect(at(to!), `${from} -> ${to}`).toBeLessThan(at(from!));
    }
  });
});
