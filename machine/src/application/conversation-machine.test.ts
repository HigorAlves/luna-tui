import { FACTORY_DEFAULTS } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import { canonicalMessageOf, emptyConversation, foldMessage } from "../domain/conversation.ts";
import type { SlackItemRow } from "../domain/slack-item.ts";
import { ConversationMachine } from "./conversation-machine.ts";

const NOW = new Date("2026-10-28T12:00:00Z");
const row = (text = "checkout is down for everyone"): SlackItemRow => {
  const channel = { id: "C1", name: "eng", kind: "channel" } as const;
  const author = { id: "U2", name: "marta", isBot: false };
  const conversation = foldMessage(emptyConversation(channel), canonicalMessageOf({ ts: "1700000000.000000", user: "U2", botId: null, text, subtype: null, threadTs: null, replyCount: 0, latestReply: null }, { channel, author, permalink: "p" }));
  return { id: "C1:1700000000.000000", kind: "mention", channel, author, text, threadTs: null, context: [], permalink: "p", ts: NOW.toISOString(), slackTs: "1700000000.000000", matched: ["me"], count: 1, replies: 0, youReplied: false, seenAt: null, doneAt: null, snoozedUntil: null, reopenedAt: null, repliedAt: null, arrivedAt: NOW.toISOString(), triage: null, linked: { pr: null, taskId: null }, conversation } as SlackItemRow;
};
const answer = (over: Record<string, unknown> = {}) => ({
  kind: { choice: "incident", confidence: 0.95 }, needs_reply: { value: true, p: 0.9 }, production_down: { value: true, p: 0.9 }, data_loss: { value: false, p: 0.05 }, security: { value: false, p: 0.05 },
  who: { score: 2, confidence: 0.9 }, what: { score: 2, confidence: 0.9 }, impact: { score: 2, confidence: 0.9 }, time: { score: 2, confidence: 0.9 }, demand: { score: 1, confidence: 0.9 }, ...over,
});
const machine = (decide: () => Promise<{ answer: unknown; recordId?: string }>) =>
  new ConversationMachine({
    enrich: async () => ({ context: { channel: "eng", private: false, thread: ["marta: checkout is down"], latest: "checkout is down", author: { profile: "member", title: null }, candidates: [] }, shortlist: [] }),
    decide,
    config: () => ({ conversation: FACTORY_DEFAULTS.conversation, scoring: FACTORY_DEFAULTS.scoring }),
    now: () => NOW,
  });

describe("ConversationMachine.assess", () => {
  it("makes the SlackTriage the board reads from the typed answers and keeps the record id on the classification", async () => {
    const out = await machine(async () => ({ answer: answer(), recordId: "rec-1" })).assess(row());
    expect(out.verdict).toBe("ok");
    expect(out.triage).toMatchObject({ priority: "P0", category: "blocker", expectsReply: true, draft: null, by: "model", overridden: false, summary: "checkout is down for everyone" });
    expect(out.triage.why).toContain("production_down");
    expect(out.classification).toMatchObject({ kind: "incident", by: "model", records: { assess: "rec-1" }, verdict: "ok" });
  });
  it.each([["bug", "request"], ["request", "request"], ["question", "question"], ["fyi", "fyi"], ["chatter", "social"]])("maps the kind %s to the category %s", async (kind, category) => {
    const out = await machine(async () => ({ answer: answer({ kind: { choice: kind, confidence: 0.95 }, production_down: { value: false, p: 0.05 } }) })).assess(row());
    expect(out.triage.category).toBe(category);
  });
  it("lists the guess and stops when the kind is unsure: verdict ask", async () => {
    const out = await machine(async () => ({ answer: answer({ kind: { choice: "bug", confidence: 0.4 } }) })).assess(row());
    expect(out.verdict).toBe("ask");
    expect(out.classification.kind).toBe("bug");
  });
  it("is not expecting a reply unless the yes is sure", async () => {
    const out = await machine(async () => ({ answer: answer({ needs_reply: { value: true, p: 0.6 } }) })).assess(row());
    expect(out.triage.expectsReply).toBe(false);
  });
  it("lets a failed call throw so the inbox retries it", async () => {
    await expect(machine(async () => { throw new Error("container failed"); }).assess(row())).rejects.toThrow("container failed");
  });
});
