import { describe, expect, it } from "vitest";

import { type Brain, type BrainAnswer, type BrainValue, noBrain } from "./brain.ts";
import { conversationBrain } from "./conversation-brain.ts";

type Row = Record<string, BrainValue>;

/** A brain that records its queries; `failing` makes every query throw. */
function fake(opts: { enabled?: boolean; cards?: Row[]; failing?: boolean } = {}) {
  const asked: Array<{ name: string; params: Record<string, string | number> }> = [];
  const brain: Brain = {
    ...noBrain(),
    enabled: opts.enabled ?? true,
    query: async (name, params = {}): Promise<BrainAnswer> => {
      asked.push({ name, params });
      if (opts.failing) throw new Error("brain down");
      return { rows: name === "search_cards_in_repo" ? (opts.cards ?? []) : [], note: null };
    },
  };
  return { brain, asked };
}
const cards = (n: number): Row[] => Array.from({ length: n }, (_, i) => ({ card: `card:c${i}`, title: `Card ${i}`, state: "closed" }));
const repoSlug = (path: string) => path.split("/").pop()!;
const tells = (on: boolean, seen: string[] = []) => async (repo: string) => (seen.push(repo), on);

describe("conversationBrain", () => {
  it("never asks the brain for a conversation with no repository", async () => {
    const { brain, asked } = fake({ cards: cards(2) });
    expect(await conversationBrain({ brain, repoSlug, tells: tells(true) })("export fails", null)).toEqual([]);
    expect(asked).toEqual([]);
  });

  it("never asks the brain when the repository's brain.tell is off", async () => {
    const { brain, asked } = fake({ cards: cards(2) });
    const seen: string[] = [];
    expect(await conversationBrain({ brain, repoSlug, tells: tells(false, seen) })("export fails", "/repos/app")).toEqual([]);
    expect(seen).toEqual(["/repos/app"]);
    expect(asked).toEqual([]);
  });

  it("answers nothing when the brain is off, even for a repository that tells", async () => {
    const { brain, asked } = fake({ enabled: false, cards: cards(2) });
    expect(await conversationBrain({ brain, repoSlug, tells: tells(true) })("export fails", "/repos/app")).toEqual([]);
    expect(asked).toEqual([]);
  });

  it("answers the rows of the thread's text for a repository that tells, at most twelve", async () => {
    const { brain, asked } = fake({ cards: cards(20) });
    const rows = await conversationBrain({ brain, repoSlug, tells: tells(true) })("export fails", "/repos/app");
    expect(rows).toHaveLength(12);
    expect(rows[0]).toMatchObject({ slug: "card:c0", kind: "card", text: expect.stringContaining("Card 0") });
    expect(asked.find((q) => q.name === "search_cards_in_repo")!.params).toEqual({ repo: "repo:app", q: "export fails" });
  });

  it("cuts the question to 2,000 characters", async () => {
    const { brain, asked } = fake({ cards: cards(1) });
    await conversationBrain({ brain, repoSlug, tells: tells(true) })("x".repeat(5000), "/repos/app");
    expect((asked.find((q) => q.name === "search_cards_in_repo")!.params.q as string).length).toBe(2000);
  });

  it("answers nothing, and does not throw, when the brain or the policy read fails", async () => {
    expect(await conversationBrain({ brain: fake({ failing: true }).brain, repoSlug, tells: tells(true) })("export fails", "/repos/app")).toEqual([]);
    const broken = async () => {
      throw new Error("no luna.yaml");
    };
    expect(await conversationBrain({ brain: fake({ cards: cards(2) }).brain, repoSlug, tells: broken })("export fails", "/repos/app")).toEqual([]);
  });

  it("reads only the thread's repository: no global search is asked, and a repository with no slug gets nothing", async () => {
    const { brain, asked } = fake({ cards: cards(1) });
    await conversationBrain({ brain, repoSlug, tells: tells(true) })("export fails", "/repos/app");
    expect(asked.map((q) => q.name)).not.toEqual(expect.arrayContaining(["search_cards"]));
    expect(asked.map((q) => q.name)).not.toContain("search_incidents");
    const none = fake({ cards: cards(1) });
    expect(await conversationBrain({ brain: none.brain, repoSlug: () => "", tells: tells(true) })("export fails", "/repos/app")).toEqual([]);
    expect(none.asked).toEqual([]);
  });
});
