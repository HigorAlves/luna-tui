import { describe, expect, it } from "vitest";

import type { ConversationRelation } from "@hardness/contracts";

import { conversationRow } from "../test/conversation-row.ts";
import { type ActionDeps, ConversationActions } from "./conversation-actions.ts";

const NOW = new Date("2026-10-28T12:00:00Z");
const relation = (over: Partial<ConversationRelation> = {}): ConversationRelation => ({ type: "none", target: null, confidence: 0.9, by: "model", at: NOW.toISOString(), ...over });

function world(linked: ReturnType<typeof conversationRow>[] = []) {
  const calls: string[] = [];
  const added: unknown[] = [];
  const deps: ActionDeps = {
    attachThread: async (card, thread) => (calls.push(`attach ${card} ${thread.channel}:${thread.ts} ${thread.authorId}`), { priority: "P1" }),
    bump: async (id) => void calls.push(`bump ${id}`),
    unbump: async (id) => void calls.push(`unbump ${id}`),
    addCandidate: async (input) => (calls.push("add"), added.push(input), { id: "b-new" }),
    linkedTo: async () => linked,
  };
  return { calls, added, actions: new ConversationActions(deps, () => NOW) };
}
const classified = (row = conversationRow()) => ({ ...row, conversation: { ...row.conversation!, classification: { kind: "bug", confidence: 0.9, by: "model" as const, at: NOW.toISOString(), records: {}, scores: { who: { score: 2, confidence: 0.9 }, what: { score: 2, confidence: 0.9 }, impact: { score: 1, confidence: 0.9 }, time: { score: 3, confidence: 0.9 }, demand: { score: 1, confidence: 0.9 } } } } });

describe("ConversationActions.apply", () => {
  it("attaches the thread to a card in progress and takes the card's priority", async () => {
    const { actions, calls } = world();
    const out = await actions.apply(conversationRow(), relation({ type: "related_to_in_progress", target: "card-1" }));
    expect(calls).toEqual(["attach card-1 C1:1700000000.000000 U2"]);
    expect(out).toMatchObject({ taskId: "card-1", priority: "P1", relation: { applied: { at: NOW.toISOString(), bumped: false } } });
  });
  it("bumps a backlog item once per thread", async () => {
    const { actions, calls } = world();
    const first = await actions.apply(conversationRow(), relation({ type: "related_to_backlog", target: "b-1" }));
    expect(calls).toEqual(["bump b-1"]);
    await actions.apply(conversationRow(), first.relation);
    expect(calls).toEqual(["bump b-1"]);
  });
  it("bumps once per author per item: a second thread by the same author adds nothing", async () => {
    const other = conversationRow({ id: "C1:1600000000.000000" });
    const applied = { ...other, conversation: { ...other.conversation!, relation: relation({ type: "related_to_backlog", target: "b-1", applied: { at: NOW.toISOString(), bumped: true } }) } };
    const { actions, calls } = world([applied]);
    const out = await actions.apply(conversationRow(), relation({ type: "related_to_backlog", target: "b-1" }));
    expect(calls).toEqual([]);
    expect(out.relation.applied).toMatchObject({ bumped: false });
    const { actions: another, calls: calls2 } = world([applied]);
    await another.apply(conversationRow({ author: "U7" }), relation({ type: "related_to_backlog", target: "b-1" }));
    expect(calls2).toEqual(["bump b-1"]);
  });
  it("adds a new candidate to the backlog only from a public channel one repository claims, with the five scores", async () => {
    const { actions, calls, added } = world();
    const out = await actions.apply(classified(), relation({ type: "new_candidate" }));
    expect(calls).toEqual(["add"]);
    expect(added[0]).toMatchObject({ repo: "/r/app", scores: { who: 2, what: 2, impact: 1, time: 3, demand: 1 }, sources: [{ kind: "slack", channel: "C1", ts: "1700000000.000000", permalink: "https://x.slack.com/p1" }] });
    expect(out.relation.applied).toMatchObject({ backlog: "b-new" });
    for (const row of [classified(conversationRow({ kind: "group" })), classified(conversationRow({ kind: "dm" })), classified(conversationRow({ repo: null }))]) {
      const w = world();
      const none = await w.actions.apply(row, relation({ type: "new_candidate" }));
      expect(w.calls).toEqual([]);
      expect(none.relation.applied?.backlog).toBeUndefined();
    }
  });
  it("records a relation of none and does nothing for ask", async () => {
    const { actions, calls } = world();
    expect((await actions.apply(conversationRow(), relation())).relation.applied).toBeDefined();
    expect((await actions.apply(conversationRow(), relation({ type: "ask" }))).relation.applied).toBeUndefined();
    expect(calls).toEqual([]);
  });
});

describe("ConversationActions.undo", () => {
  it("unbumps the item when a person moves the thread away from it, and not when the target is kept", async () => {
    const { actions, calls } = world();
    const was = relation({ type: "related_to_backlog", target: "b-1", applied: { at: NOW.toISOString(), bumped: true } });
    await actions.undo(was, relation({ type: "related_to_backlog", target: "b-1", by: "person" }));
    expect(calls).toEqual([]);
    await actions.undo(was, relation({ type: "none", by: "person" }));
    expect(calls).toEqual(["unbump b-1"]);
    await actions.undo(relation({ type: "related_to_backlog", target: "b-2", applied: { at: NOW.toISOString(), bumped: false } }), relation({ type: "none" }));
    expect(calls).toEqual(["unbump b-1"]);
  });
});
