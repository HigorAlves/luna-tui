import { describe, expect, it } from "vitest";

import { searchCards } from "./card-search.ts";

const NOW = new Date("2026-11-05T00:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);
const card = (id: string, title: string, over: Record<string, unknown> = {}) => ({ id, title, description: "", state: "triage", repoPath: "/repo/a", stateSince: daysAgo(1), record: null, ...over });
const search = (cards: ReturnType<typeof card>[], query: string, repoPath: string | null = "/repo/a") => searchCards(cards, query, { repoPath, selfId: "me", now: NOW });

describe("searchCards", () => {
  it("finds the cards of the same repository that share words with the query, best first, as ids, titles, states and one-line summaries", () => {
    const hits = search([card("1", "Export CSV of reports", { record: { summary: "Add a CSV export\nto the report page" } }), card("2", "Dark mode"), card("3", "CSV import")], "csv export broken");
    expect(hits).toEqual([
      { id: "1", title: "Export CSV of reports", state: "triage", summary: "Add a CSV export to the report page" },
      { id: "3", title: "CSV import", state: "triage", summary: "" },
    ]);
  });

  it("returns nothing from another repository, nor for a card with no repository", () => {
    const cards = [card("1", "Export CSV", { repoPath: "/repo/b" }), card("2", "Export CSV", { repoPath: null })];
    expect(search(cards, "export csv")).toEqual([]);
    expect(search([card("1", "Export CSV")], "export csv", null)).toEqual([]);
  });

  it("includes closed and archived cards of the last 90 days only, never the card itself", () => {
    const cards = [card("1", "Export CSV", { state: "closed", stateSince: daysAgo(89) }), card("2", "Export CSV", { state: "archived", stateSince: daysAgo(91) }), card("3", "Export CSV", { state: "closed", stateSince: null }), card("me", "Export CSV")];
    expect(search(cards, "export csv").map((h) => h.id)).toEqual(["1"]);
  });

  it("caps the list at ten and ignores a query of stop words", () => {
    const cards = Array.from({ length: 15 }, (_, i) => card(String(i), `Export CSV ${i}`));
    expect(search(cards, "export csv")).toHaveLength(10);
    expect(search(cards, "the and for")).toEqual([]);
  });
});
