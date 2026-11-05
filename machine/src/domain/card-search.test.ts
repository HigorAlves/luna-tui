import { describe, expect, it } from "vitest";

import { searchCards } from "./card-search.ts";

const NOW = new Date("2026-11-05T00:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);
const card = (id: string, title: string, over: Record<string, unknown> = {}) => ({ id, title, state: "triage", repoPath: "/repo/a", stateSince: daysAgo(1), source: { kind: "github" }, description: "private description", record: { summary: "private summary" }, ...over });
const search = (cards: ReturnType<typeof card>[], query: string, options: { repoPath?: string | null; selfSource?: string | null } = {}) =>
  searchCards(cards, query, { repoPath: options.repoPath === undefined ? "/repo/a" : options.repoPath, selfSource: options.selfSource === undefined ? "github" : options.selfSource, selfId: "me", now: NOW });

describe("searchCards", () => {
  it("finds the cards of the same repository that share words with the query in their title, best first, as ids, titles and states only", () => {
    const hits = search([card("1", "Export CSV of reports"), card("2", "Dark mode"), card("3", "CSV import")], "csv export broken");
    expect(hits).toEqual([
      { id: "1", title: "Export CSV of reports", state: "triage" },
      { id: "3", title: "CSV import", state: "triage" },
    ]);
  });

  it("returns no summary and no description, and matches on titles only: a word only a private summary holds finds nothing", () => {
    const hits = search([card("1", "Export CSV", { record: { summary: "contains the word hunter2" }, description: "secret roadmap" })], "export hunter2 roadmap");
    expect(hits).toEqual([{ id: "1", title: "Export CSV", state: "triage" }]);
    for (const hit of hits) expect(Object.keys(hit).sort()).toEqual(["id", "state", "title"]);
    expect(search([card("1", "Export CSV", { record: { summary: "hunter2" } })], "hunter2")).toEqual([]);
  });

  it("shows a GitHub-sourced card only GitHub-sourced cards, a Jira card only Jira, a Slack card only Slack", () => {
    const cards = [card("g", "Export CSV", { source: { kind: "github" } }), card("j", "Export CSV", { source: { kind: "jira" } }), card("s", "Export CSV", { source: { kind: "slack" } }), card("m", "Export CSV", { source: null })];
    expect(search(cards, "export csv", { selfSource: "github" }).map((h) => h.id)).toEqual(["g"]);
    expect(search(cards, "export csv", { selfSource: "jira" }).map((h) => h.id)).toEqual(["j"]);
    expect(search(cards, "export csv", { selfSource: "slack" }).map((h) => h.id)).toEqual(["s"]);
  });

  it("lets a card typed in the TUI, with no source, see every source of its own repository", () => {
    const cards = [card("g", "Export CSV", { source: { kind: "github" } }), card("j", "Export CSV", { source: { kind: "jira" } }), card("s", "Export CSV", { source: { kind: "slack" } }), card("m", "Export CSV", { source: null }), card("x", "Export CSV", { repoPath: "/repo/b", source: { kind: "github" } })];
    expect(search(cards, "export csv", { selfSource: null }).map((h) => h.id).sort()).toEqual(["g", "j", "m", "s"]);
  });

  it("returns nothing from another repository, nor for a card with no repository", () => {
    const cards = [card("1", "Export CSV", { repoPath: "/repo/b" }), card("2", "Export CSV", { repoPath: null })];
    expect(search(cards, "export csv")).toEqual([]);
    expect(search([card("1", "Export CSV")], "export csv", { repoPath: null })).toEqual([]);
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
