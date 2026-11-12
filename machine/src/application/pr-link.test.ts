import { describe, expect, it, vi } from "vitest";

import { fakeJira } from "../test/jira.ts";
import { type LinkableCard, type PrLinkDeps, linkReview, matchByFact } from "./pr-link.ts";

const PR_URL = "https://github.com/o/a/pull/12";
const pr = (over: Partial<{ title: string; body: string | null; headRef: string }> = {}) => ({ repo: "o/a", number: 12, url: PR_URL, title: "Export CSV", body: null, headRef: "feat/export", ...over });

const card = (over: Partial<LinkableCard> & { id: string }): LinkableCard => ({
  title: `Card ${over.id}`,
  description: "",
  criteria: [],
  state: "implementing",
  route: "feature",
  repoPath: "/r/a",
  branch: null,
  source: null,
  jira: null,
  stateSince: null,
  ...over,
});
const jiraLink = (key: string) => ({ key, url: `https://acme.atlassian.net/browse/${key}`, issueType: "Story", status: "To Do", priority: null, dueAt: null, syncedAt: null, blocked: null });

describe("matchByFact", () => {
  const none = async () => [] as string[];

  it("matches a card whose Jira link or Jira source is a key the PR names", async () => {
    const cards = [
      card({ id: "linked", jira: jiraLink("DISC-1") }),
      card({ id: "sourced", source: { kind: "jira", key: "DISC-1", url: "u", issueType: null } }),
      card({ id: "notch", source: { kind: "notch", ref: "LUNA-1", id: "n", jiraKey: "DISC-1" } }),
      card({ id: "other", jira: jiraLink("DISC-9") }),
    ];
    const found = await matchByFact(cards, pr(), ["DISC-1"], "me", none);
    expect(found.map((f) => [f.card.id, f.fact])).toEqual([["linked", "jira"], ["sourced", "jira"], ["notch", "jira"]]);
  });

  it("matches a card whose branch is the PR's head branch", async () => {
    const found = await matchByFact([card({ id: "a", branch: "feat/export" }), card({ id: "b", branch: "feat/other" }), card({ id: "c", branch: null })], pr(), [], "me", none);
    expect(found.map((f) => [f.card.id, f.fact])).toEqual([["a", "branch"]]);
  });

  it("matches a card whose recorded PR is this one: a pr.opened event, or its source", async () => {
    const prUrls = vi.fn(async (id: string) => (id === "opened" ? [PR_URL.toUpperCase() + "/", "https://github.com/o/a/pull/99"] : []));
    const cards = [
      card({ id: "opened", branch: "task/x" }),
      card({ id: "elsewhere", branch: "task/y" }),
      card({ id: "sourced", source: { kind: "github_pr", repo: "O/A", number: 12, url: PR_URL, headRef: "h", baseRef: "main" } }),
      card({ id: "other-pr", source: { kind: "github_pr", repo: "o/a", number: 13, url: "https://github.com/o/a/pull/13", headRef: "h", baseRef: "main" } }),
    ];
    const found = await matchByFact(cards, pr(), [], "me", prUrls);
    expect(found.map((f) => [f.card.id, f.fact])).toEqual([["opened", "pr"], ["sourced", "pr"]]);
  });

  it("skips closed and archived cards, review tasks, and the review's own task", async () => {
    const cards = [
      card({ id: "closed", branch: "feat/export", state: "closed" }),
      card({ id: "archived", branch: "feat/export", state: "archived" }),
      card({ id: "review", branch: "feat/export", route: "review" }),
      card({ id: "me", branch: "feat/export" }),
      card({ id: "draft", branch: "feat/export", state: "draft" }),
    ];
    const found = await matchByFact(cards, pr(), [], "me", none);
    expect(found.map((f) => f.card.id)).toEqual(["draft"]);
  });

  it("names a card once, by the first fact that matched, and keeps at most three", async () => {
    const cards = Array.from({ length: 5 }, (_, i) => card({ id: `c${i}`, branch: "feat/export", jira: jiraLink("DISC-1") }));
    const found = await matchByFact(cards, pr(), ["DISC-1"], "me", none);
    expect(found).toHaveLength(3);
    expect(found.every((f) => f.fact === "jira")).toBe(true);
  });

  it("does not read a card's events when a cheaper fact already matched, nor for a card with no branch and no source", async () => {
    const prUrls = vi.fn(none);
    await matchByFact([card({ id: "a", branch: "feat/export" }), card({ id: "b" })], pr(), [], "me", prUrls);
    expect(prUrls).not.toHaveBeenCalled();
  });
});

describe("linkReview", () => {
  const input = (over: Partial<{ pr: ReturnType<typeof pr>; files: string[] }> = {}) => ({ pr: pr(), files: ["src/export.ts"], repoPath: "/r/a", selfId: "me", ...over });
  const answerOf = (choice: string, confidence: number) => ({ match: { choice, confidence } });
  const deps = (cards: LinkableCard[], extra: Partial<PrLinkDeps> = {}): PrLinkDeps => ({ cards: async () => cards, prUrls: async () => [], ...extra });
  const decision = (answer: Record<string, unknown> | Error, over: { available?: boolean; overrides?: Record<string, { proceed?: number; flag?: number }> } = {}) => {
    const decide = vi.fn(async () => {
      if (answer instanceof Error) throw answer;
      return answer;
    });
    return { decide, decision: { available: async () => over.available ?? true, decide, overrides: async () => over.overrides ?? {} } };
  };
  const issues = [
    { key: "DISC-12", summary: "Export to CSV", description: "Users want a CSV export of the table." },
    { key: "DISC-13", summary: "Slow page", description: "" },
  ];

  it("links the cards that match by fact, and the Jira key of such a card the PR did not name", async () => {
    const found = await linkReview({ links: deps([card({ id: "a", branch: "feat/export", jira: jiraLink("DISC-12") })]) }, input());
    expect(found.cards.map((c) => [c.card.id, c.how, c.fact])).toEqual([["a", "fact", "branch"]]);
    expect(found.jira).toEqual([{ key: "DISC-12", how: "fact" }]);
    expect(found.suggestion).toBeUndefined();
  });

  it("names a Jira key the PR carries as `key`, once, even when a card is linked to it too", async () => {
    const found = await linkReview({ links: deps([card({ id: "a", jira: jiraLink("DISC-12") })]) }, input({ pr: pr({ title: "Export (DISC-12)" }) }));
    expect(found.jira).toEqual([{ key: "DISC-12", how: "key" }]);
    expect(found.cards.map((c) => [c.card.id, c.how, c.fact])).toEqual([["a", "fact", "jira"]]);
  });

  it("keeps the projects the machine knows when it reads the PR's keys", async () => {
    const found = await linkReview({ links: deps([]), projects: async () => ["PLAT"] }, input({ pr: pr({ title: "Export (DISC-12)" }) }));
    expect(found.jira).toEqual([]);
  });

  it("never asks the decision when the PR names a key or a card matched by fact", async () => {
    const named = decision(answerOf("slot1", 0.95));
    await linkReview({ links: deps([], { decision: named.decision }), jira: fakeJira({ issues }) }, input({ pr: pr({ title: "Export (DISC-12)" }) }));
    const matched = decision(answerOf("slot1", 0.95));
    await linkReview({ links: deps([card({ id: "a", branch: "feat/export" })], { decision: matched.decision }), jira: fakeJira({ issues }) }, input());
    expect(named.decide).not.toHaveBeenCalled();
    expect(matched.decide).not.toHaveBeenCalled();
  });

  describe("the fallback", () => {
    const cards = [card({ id: "c1", title: "Export the table as CSV", description: "Add a CSV export button." }), card({ id: "c2", title: "Pay button", description: "" })];

    it("hands the decision the PR and up to five Jira tickets and five cards, by slot, Jira first", async () => {
      const many = Array.from({ length: 8 }, (_, i) => ({ key: `DISC-${100 + i}`, summary: `Export thing ${i}`, description: "d" }));
      const jira = fakeJira({ issues: many });
      const board = Array.from({ length: 8 }, (_, i) => card({ id: `x${i}`, title: `Export card ${i}`, description: "e".repeat(5000) }));
      const asked = decision(answerOf("none", 0.9));
      await linkReview({ links: deps(board, { decision: asked.decision }), jira, projects: async () => ["DISC"] }, input({ pr: pr({ title: "Export CSV", body: "b".repeat(5000) }), files: Array.from({ length: 60 }, (_, i) => `f${i}.ts`) }));
      const context = (asked.decide.mock.calls[0] as unknown as [{ pr: { title: string; branch: string; body: string; files: string[] }; candidates: Array<{ slot: number; kind: string; id: string; excerpt: string }> }])[0];
      expect(context.pr).toMatchObject({ title: "Export CSV", branch: "feat/export" });
      expect(context.pr.body.length).toBeLessThanOrEqual(3000);
      expect(context.pr.files).toHaveLength(40);
      expect(context.candidates.map((c) => c.slot)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      expect(context.candidates.map((c) => c.kind)).toEqual(["jira", "jira", "jira", "jira", "jira", "card", "card", "card", "card", "card"]);
      expect(context.candidates[5]!.excerpt.length).toBeLessThanOrEqual(1000);
      expect(jira.searches).toHaveLength(1);
      expect(jira.searches[0]).toContain("statusCategory != Done");
      expect(jira.searches[0]).toContain("project in (DISC)");
      expect(jira.searches[0]).toMatch(/text ~ "export"/);
    });

    it("links a Jira candidate the decision picks at or above the proceed bar, as `decision`", async () => {
      const asked = decision(answerOf("slot1", 0.7));
      const found = await linkReview({ links: deps(cards, { decision: asked.decision }), jira: fakeJira({ issues }), projects: async () => ["DISC"] }, input());
      expect(found.jira).toEqual([{ key: "DISC-12", how: "decision" }]);
      expect(found.cards).toEqual([]);
      expect(found.suggestion).toBeUndefined();
    });

    it("links a card the decision picks above the bar", async () => {
      const asked = decision(answerOf("slot3", 0.9));
      const found = await linkReview({ links: deps(cards, { decision: asked.decision }), jira: fakeJira({ issues }), projects: async () => ["DISC"] }, input());
      const picked = asked.decide.mock.calls[0] as unknown as [{ candidates: Array<{ slot: number; id: string }> }];
      expect(picked[0].candidates.find((c) => c.slot === 3)?.id).toBe("c1");
      expect(found.cards.map((c) => [c.card.id, c.how])).toEqual([["c1", "decision"]]);
      expect(found.jira).toEqual([]);
    });

    it("links nothing and records the best candidate as a suggestion under the bar", async () => {
      const asked = decision(answerOf("slot1", 0.6));
      const found = await linkReview({ links: deps(cards, { decision: asked.decision }), jira: fakeJira({ issues }), projects: async () => ["DISC"] }, input());
      expect(found.jira).toEqual([]);
      expect(found.cards).toEqual([]);
      expect(found.suggestion).toEqual({ kind: "jira", id: "DISC-12", title: "Export to CSV", confidence: 0.6, url: "https://acme.atlassian.net/browse/DISC-12" });
    });

    it("suggests a card by its id and title", async () => {
      const asked = decision(answerOf("slot3", 0.55));
      const found = await linkReview({ links: deps(cards, { decision: asked.decision }), jira: fakeJira({ issues }), projects: async () => ["DISC"] }, input());
      expect(found.suggestion).toEqual({ kind: "card", id: "c1", title: "Export the table as CSV", confidence: 0.55 });
    });

    it("links nothing and suggests nothing when the decision says none", async () => {
      const found = await linkReview({ links: deps(cards, { decision: decision(answerOf("none", 0.99)).decision }), jira: fakeJira({ issues }), projects: async () => ["DISC"] }, input());
      expect(found).toEqual({ jira: [], cards: [] });
    });

    it("reads the repo's own bar for the pack", async () => {
      const strict = decision(answerOf("slot1", 0.8), { overrides: { match: { proceed: 0.9 } } });
      const found = await linkReview({ links: deps(cards, { decision: strict.decision }), jira: fakeJira({ issues }), projects: async () => ["DISC"] }, input());
      expect(found.jira).toEqual([]);
      expect(found.suggestion).toMatchObject({ id: "DISC-12", confidence: 0.8 });
    });

    it("ignores a slot the shortlist does not hold", async () => {
      const found = await linkReview({ links: deps(cards, { decision: decision(answerOf("slot9", 0.99)).decision }) }, input());
      expect(found).toEqual({ jira: [], cards: [] });
    });

    it("skips quietly when Jev is not configured: no search, no call", async () => {
      const off = decision(answerOf("slot1", 0.99), { available: false });
      const jira = fakeJira({ issues });
      const found = await linkReview({ links: deps(cards, { decision: off.decision }), jira, projects: async () => ["DISC"] }, input());
      expect(off.decide).not.toHaveBeenCalled();
      expect(jira.searches).toEqual([]);
      expect(found).toEqual({ jira: [], cards: [] });
      expect(await linkReview({ links: deps(cards), jira }, input())).toEqual({ jira: [], cards: [] });
    });

    it("does not call the decision when there is no candidate at all", async () => {
      const asked = decision(answerOf("slot1", 0.99));
      const found = await linkReview({ links: deps([], { decision: asked.decision }), jira: fakeJira({ issues: [] }), projects: async () => ["DISC"] }, input());
      expect(asked.decide).not.toHaveBeenCalled();
      expect(found).toEqual({ jira: [], cards: [] });
    });

    it("falls back to the cards alone when Jira cannot be searched, or no project is known", async () => {
      const failing = fakeJira({ issues, failing: { search: new Error("boom") } });
      const asked = decision(answerOf("slot1", 0.9));
      const found = await linkReview({ links: deps(cards, { decision: asked.decision }), jira: failing, projects: async () => ["DISC"], log: () => {} }, input());
      expect(found.cards.map((c) => c.card.id)).toEqual(["c1"]);
      const unscoped = fakeJira({ issues });
      await linkReview({ links: deps(cards, { decision: decision(answerOf("none", 0.9)).decision }), jira: unscoped }, input());
      expect(unscoped.searches).toEqual([]);
    });

    it("never fails the review: a decision that throws links nothing", async () => {
      const log = vi.fn();
      const found = await linkReview({ links: deps(cards, { decision: decision(new Error("jev is down")).decision }), log }, input());
      expect(found).toEqual({ jira: [], cards: [] });
      expect(log).toHaveBeenCalledWith(expect.stringContaining("jev is down"));
    });

    it("leaves closed, archived and non-feature cards out of the candidates", async () => {
      const asked = decision(answerOf("none", 0.9));
      const board = [card({ id: "closed", title: "Export done", state: "closed" }), card({ id: "r", title: "Export review", route: "review" }), card({ id: "ok", title: "Export open" }), card({ id: "me", title: "Export self" })];
      await linkReview({ links: deps(board, { decision: asked.decision }) }, input());
      const context = (asked.decide.mock.calls[0] as unknown as [{ candidates: Array<{ id: string }> }])[0];
      expect(context.candidates.map((c) => c.id)).toEqual(["ok"]);
    });
  });
});
