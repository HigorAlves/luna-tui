import { describe, expect, it } from "vitest";

import { fakeMemory } from "../test/memory.ts";
import { noMemory } from "./memory.ts";
import { recallSimilar, similarCardIds, similarOutcomes, viewerOfCard } from "./memory-similar.ts";

const github = { kind: "github" as const, repo: "o/a", number: 1, url: "https://github.com/o/a/issues/1" };
const slack = { kind: "slack" as const, channel: "C1", ts: "1.2", permalink: "https://x" };

async function seeded() {
  const memory = fakeMemory();
  const base = { repo: "r", anchors: { files: [], commit: null }, trust: "fact" as const };
  await memory.write([
    { ...base, kind: "outcome", source: { kind: "github", ref: "o/a" }, provenance: { by: "machine", card: "card-1", run: null, pack: null }, text: "Card checkout card payment fails: predicted size M risk low 120 lines, changed 340 lines, 2 retries, 1 escalation." },
    { ...base, kind: "outcome", source: { kind: "slack", ref: "C9" }, provenance: { by: "machine", card: "card-slack", run: null, pack: null }, text: "Card checkout payment form: predicted size S, changed 20 lines." },
    { ...base, kind: "lesson", source: { kind: "github", ref: "o/a" }, provenance: { by: "person", card: "card-2", run: null, pack: null }, text: "Checkout payment lesson, not an outcome." },
  ]);
  return memory;
}

describe("the viewer of a new card", () => {
  it("is its own source, and the operator's own (tui) with none", () => {
    expect(viewerOfCard({ repoSlug: "r", source: github }).source).toEqual({ kind: "github", ref: "o/a" });
    expect(viewerOfCard({ repoSlug: "r", source: slack }).source).toEqual({ kind: "slack", ref: "C1" });
    expect(viewerOfCard({ repoSlug: "r", source: { kind: "jira", key: "PLAT-12", url: "u", issueType: null } }).source).toEqual({ kind: "jira", ref: "PLAT" });
    expect(viewerOfCard({ repoSlug: "r", source: null }).source).toEqual({ kind: "tui", ref: null });
    expect(viewerOfCard({ repoSlug: "r", source: null }).publicPost).toBe(false);
  });
});

describe("similar past cards from memory", () => {
  const subject = { title: "Checkout payment fails", text: "the card payment form throws" };

  it("maps recalled outcome items to their cards, from the card's own source only", async () => {
    const memory = await seeded();
    const ids = await similarCardIds(memory, subject, viewerOfCard({ repoSlug: "r", source: github }));
    expect(ids).toEqual(["card-1"]);
  });

  it("a card typed in the TUI sees every source of its repository", async () => {
    const memory = await seeded();
    const ids = await similarCardIds(memory, subject, viewerOfCard({ repoSlug: "r", source: null }));
    expect(new Set(ids)).toEqual(new Set(["card-1", "card-slack"]));
  });

  it("recalls outcomes and findings only", async () => {
    const memory = await seeded();
    const found = await recallSimilar(memory, subject, viewerOfCard({ repoSlug: "r", source: null }));
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((f) => f.item.kind === "outcome" || f.item.kind === "finding")).toBe(true);
  });

  it("shows triage at most five outcomes as capped data, never the card itself", async () => {
    const memory = await seeded();
    const out = await similarOutcomes(memory, { ...subject, id: "card-1" }, viewerOfCard({ repoSlug: "r", source: null }));
    expect(out.map((o) => o.card)).toEqual(["card-slack"]);
    const all = await similarOutcomes(memory, subject, viewerOfCard({ repoSlug: "r", source: null }));
    expect(all[0]!.text).toContain("predicted");
    expect(all.length).toBeLessThanOrEqual(5);
  });

  it("with memory off, or a failing recall, is nothing", async () => {
    const viewer = viewerOfCard({ repoSlug: "r", source: github });
    expect(await similarCardIds(noMemory(), subject, viewer)).toEqual([]);
    const broken = {
      ...fakeMemory(),
      recall: async () => {
        throw new Error("cognee down");
      },
    };
    expect(await similarCardIds(broken, subject, viewer)).toEqual([]);
    expect(await similarOutcomes(broken, subject, viewer)).toEqual([]);
  });
});
