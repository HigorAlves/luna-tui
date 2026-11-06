import { describe, expect, it } from "vitest";

import type { ConversationRelation } from "@hardness/contracts";

import { conversationRow } from "../test/conversation-row.ts";
import { ConversationDrafter, type DraftDeps } from "./conversation-draft.ts";

const relation = (over: Partial<ConversationRelation> = {}): ConversationRelation => ({ type: "related_to_in_progress", target: "card-1", confidence: 0.9, by: "model", at: "2026-10-28T12:00:00Z", ...over });
const row = (rel: ConversationRelation | null, over: { kind?: string; verdict?: "ok" | "ask"; needsReply?: boolean; shortlist?: Array<{ slot: number; id: string; kind: "open" | "closed" | "backlog"; otherSource: null }> } = {}) => {
  const base = conversationRow();
  return { ...base, triage: { priority: "P1", category: "request", expectsReply: over.needsReply ?? true, summary: "s", why: "w", draft: null, refs: [], deadline: null, by: "model", triagedAt: "t", overridden: false } as never, conversation: { ...base.conversation!, classification: { kind: over.kind ?? "bug", confidence: 0.9, by: "model" as const, at: "t", records: {}, verdict: over.verdict ?? "ok" }, relation: rel, shortlist: over.shortlist ?? [{ slot: 1, id: "card-1", kind: "open" as const, otherSource: null }, { slot: 2, id: "b-1", kind: "backlog" as const, otherSource: null }] } };
};
const world = (reply: string | Error = "It is queued.") => {
  const contexts: Array<{ reply?: { relation: string; card: string | null; docs: string[]; tone: unknown[] } }> = [];
  const deps: DraftDeps = {
    card: async (id) => (id === "card-1" ? { state: "in progress", title: "Checkout fails", pr: "https://github.com/acme/app/pull/4", evidence: "Results: 3 passed" } : null),
    rank: async () => "ranks 4th of 12",
    docs: async () => ["docs/checkout.md: retries"],
    tone: async () => [],
    run: async (context) => {
      contexts.push(context as never);
      if (reply instanceof Error) throw reply;
      return { reply, confidence: 0.8 };
    },
  };
  return { contexts, drafter: new ConversationDrafter(deps) };
};

describe("ConversationDrafter", () => {
  it("drafts for a sure need of a reply on a relation that is not ask, with the card's part from the stored shortlist only", async () => {
    const { drafter, contexts } = world();
    expect(await drafter.draft(row(relation()))).toBe("It is queued.");
    expect(contexts[0]!.reply).toMatchObject({ relation: "related_to_in_progress", card: expect.stringContaining("https://github.com/acme/app/pull/4"), docs: ["docs/checkout.md: retries"] });
    expect(contexts[0]!.reply!.card).not.toContain("Results: 3 passed\u0000");
  });
  it("gives no card part when the target is not a card in the channel's own shortlist", async () => {
    const { drafter, contexts } = world();
    await drafter.draft(row(relation({ target: "card-9" })));
    expect(contexts[0]!.reply!.card).toBeNull();
    await drafter.draft(row(relation({ type: "related_to_backlog", target: "b-1" })));
    expect(contexts[1]!.reply!.card).toContain("queued");
    expect(contexts[1]!.reply!.card).toContain("ranks 4th of 12");
  });
  it("asks for nothing when no reply is needed, the kind is fyi or chatter, the verdict or the relation is ask, or the relation is missing", async () => {
    const { drafter, contexts } = world();
    for (const r of [row(relation(), { needsReply: false }), row(relation(), { kind: "fyi" }), row(relation(), { kind: "chatter" }), row(relation(), { verdict: "ask" }), row(relation({ type: "ask", target: null })), row(null)]) expect(await drafter.draft(r)).toBeNull();
    expect(contexts).toEqual([]);
  });
  it("refuses an answer that carries a secret, checked on the raw text, and flattens a good one", async () => {
    const token = ["gh", "p_", "a".repeat(36)].join("");
    expect(await world(`use ${token} to log in`).drafter.draft(row(relation()))).toBeNull();
    expect(await world("Line one\n\n@channel see <https://evil.example|here>").drafter.draft(row(relation()))).not.toMatch(/@channel|\n/);
  });
  it("lets a failed run throw so the inbox retries", async () => {
    await expect(world(new Error("container failed")).drafter.draft(row(relation()))).rejects.toThrow("container failed");
  });
});
