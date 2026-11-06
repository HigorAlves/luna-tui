// The heart of wave 17: nothing reaches Slack, and no card is made from a conversation, without a person's tap. The real SlackInbox and the real
// ThreadReplies run over a recording Slack and a recording fetch, every default in place: the poll, the clocks, the event handlers, the retries
// and the outbound events of a card. Then each tap makes exactly one write.
import { FACTORY_DEFAULTS } from "@hardness/contracts";
import type { DataSource } from "typeorm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { EventRow } from "../domain/task.ts";
import { freshTestDatabase } from "../test/database.ts";
import { fakeGitHub } from "../test/github.ts";
import { MemorySlackStore, fakeSlack } from "../test/slack.ts";
import { ChannelClaims } from "./channel-claims.ts";
import type { Assessed } from "./conversation-machine.ts";
import { ConversationDrafts, MemoryDraftStore } from "./conversation-drafts.ts";
import { Pipeline } from "./pipeline.ts";
import { SlackInbox } from "./slack-inbox.ts";
import { SlackRefusedError, SlackSender, standingOf, tapOf } from "./slack-send.ts";
import type { RawMessage, SearchHit } from "./slack.ts";
import { StubStages } from "./stages/stubs.ts";
import { ThreadReplies } from "./threads.ts";

let db: DataSource;
beforeAll(async () => {
  db = await freshTestDatabase();
});
afterAll(async () => {
  await db.destroy();
});
beforeEach(async () => {
  await db.query("truncate tasks cascade");
});

const T0 = new Date("2026-10-28T12:00:00Z");
const ts = (minutesAgo: number): string => ((T0.getTime() - minutesAgo * 60_000) / 1000).toFixed(6);
const iso = (): string => T0.toISOString();
const WRITES = ["postMessage", "mark", "openDm"];

const assessed = (): Assessed => ({
  triage: { priority: "P1", category: "request", expectsReply: true, summary: "s", why: "bug", draft: null, refs: [], deadline: null, by: "model", triagedAt: iso(), overridden: false },
  classification: { kind: "bug", confidence: 0.9, by: "model", at: iso(), records: { assess: "rec-1" }, verdict: "ok", priority: "P1", scores: { who: { score: 2, confidence: 0.9 }, what: { score: 2, confidence: 0.9 }, impact: { score: 2, confidence: 0.9 }, time: { score: 2, confidence: 0.9 }, demand: { score: 1, confidence: 0.9 } } },
  verdict: "ok",
  relation: { type: "new_candidate", target: null, confidence: 0.9, by: "model", at: iso() },
  shortlist: [],
});

/** The real inbox over a recording Slack, with the conversation chain, a drafter, a backlog that records and a card maker that counts. */
async function world(over: { auto?: "on" | "off"; searchError?: string; assess?: () => Promise<Assessed>; clock?: { ms: number } } = {}) {
  const clock = over.clock ?? { ms: T0.getTime() };
  const hits: SearchHit[] = [{ text: "<@U1> checkout fails", user: "U2", channel: { id: "C1", name: "eng" }, ts: ts(10), permalink: `https://x.slack.com/archives/C1/p${ts(10).replace(".", "")}` }];
  const slack = fakeSlack({
    me: async () => ({ id: "U1", name: "higor" }),
    searchMentions: async () => {
      if (over.searchError) throw new Error(over.searchError);
      return { hits, nextCursor: null };
    },
    conversations: async () => [{ id: "C1", name: "eng", kind: "channel" as const }],
    history: async () => [] as RawMessage[],
    replies: async () => [] as RawMessage[],
    usergroups: async () => [],
    userInfo: async (id: string) => ({ id, name: id === "U2" ? "marta" : "higor", isBot: false }),
    channelInfo: async (id: string) => ({ id, name: "eng", kind: "channel" as const }),
    permalink: async (channel: string, t: string) => `https://x.slack.com/archives/${channel}/p${t.replace(".", "")}`,
    postMessage: async () => "9.9",
    mark: async () => {},
    openDm: async () => "D1",
  });
  const fetched: string[] = [];
  const recordingFetch = (async (url: string) => (fetched.push(String(url)), { json: async () => ({ ok: true, ts: "8.8" }) })) as unknown as typeof fetch;
  const sender = new SlackSender(slack);
  const store = new MemorySlackStore();
  const drafts = new ConversationDrafts(new MemoryDraftStore(), { expiryHours: () => 24, now: () => new Date(clock.ms) });
  const created: unknown[] = [];
  const conv = { ...FACTORY_DEFAULTS.conversation, ...(over.auto ? { auto: over.auto } : {}) };
  const claims = { refresh: async () => {}, repoOf: () => "/r/a", claimed: () => ["C1"], configOf: () => ({ conversation: conv, scoring: FACTORY_DEFAULTS.scoring }) } as unknown as ChannelClaims;
  const stubs = new StubStages();
  const pipeline = new Pipeline(db, stubs.runnerFor, { inline: true, hasConfig: () => true });
  const inbox = new SlackInbox({
    slack, triager: null, store, intervalMs: 60_000, publish: () => {}, findTask: async (id: string) => pipeline.get(id).catch(() => null), linkPr: () => null,
    createTask: async (input: Parameters<Pipeline["createTask"]>[0]) => (created.push(input), pipeline.createTask(input)),
    markRead: true, scope: "all", claims, rulesPath: "/rules.md", socketToken: null, now: () => new Date(clock.ms),
    files: { read: async () => null, write: async () => {} },
    assessor: { assess: over.assess ?? (async () => assessed()) },
    drafter: { draft: async () => "It is queued." },
    drafts,
    sender,
    digest: true,
    actions: { apply: async (_row: unknown, relation: Record<string, unknown>) => ({ relation: { ...relation, applied: { at: iso(), bumped: false } } }), undo: async () => {} },
  } as never);
  const replies = new ThreadReplies({
    pipeline, github: fakeGitHub({ commentOnIssue: async () => {} }), enabled: true,
    slack: { token: "xoxb-test", channel: "C123", fetch: recordingFetch },
    slackPort: () => slack,
    drafts, store, sender, autoOf: () => conv.auto === "on",
  } as never);
  return { slack, sender, inbox, replies, pipeline, store, drafts, created, fetched, clock, writes: () => (slack.calls as unknown[][]).filter((c) => WRITES.includes(String(c[0]))) };
}

const event = (taskId: string, kind: string, payload: Record<string, unknown>): EventRow => ({ id: "e", taskId, kind, payload, stageRunId: null, createdAt: T0 } as unknown as EventRow);
const slackCard = (pipeline: Pipeline) => pipeline.createTask({ title: "Checkout fails", repoPath: "/r/a", source: { kind: "slack", channel: "C1", ts: ts(10), permalink: "https://x.slack.com/archives/C1/p1" } });

describe("nothing reaches Slack without a tap", () => {
  it("polls, ticks, handles events, retries and expires drafts, and the recording Slack sees no write, no card is made and the draft waits", async () => {
    let failures = 1;
    const w = await world({ assess: async () => (failures-- > 0 ? Promise.reject(new Error("container failed")) : assessed()) });
    await w.inbox.pollOnce();
    await w.inbox.pollOnce(true);
    w.clock.ms += 2 * 60_000;
    w.inbox.tick();
    await w.inbox.pollOnce(true);
    w.clock.ms += 5 * 60_000;
    w.inbox.tick();
    await new Promise((r) => setTimeout(r, 20));
    w.inbox.handleSocketEvent({ type: "message", channel: "C1", ts: ts(1), user: "U2", text: "<@U1> still failing", thread_ts: ts(10) } as never);
    w.inbox.handleSocketEvent({ type: "reaction_added", user: "U3", reaction: "eyes", item_user: "U1", item: { type: "message", channel: "C1", ts: ts(10) }, event_ts: ts(0) } as never);
    w.inbox.handleSocketEvent({ type: "message", subtype: "message_changed", channel: "C1", ts: ts(0), message: { ts: ts(10), text: "<@U1> checkout fails again" } } as never);
    await w.inbox.pollOnce(true);
    w.clock.ms += 25 * 3_600_000;
    await w.inbox.expireDrafts();
    expect(w.writes()).toEqual([]);
    expect(w.fetched).toEqual([]);
    expect(w.created).toEqual([]);
  });

  it("keeps the drafts of a thread waiting (not posted) while it is assessed", async () => {
    const w = await world();
    await w.inbox.pollOnce();
    await new Promise((r) => setTimeout(r, 20));
    const waiting = await w.drafts.allWaiting();
    expect(waiting.map((d) => d.text)).toEqual(["It is queued."]);
    expect(w.writes()).toEqual([]);
  });

  it("turns every outbound event of a Slack-sourced card into a draft on the thread it came from, and posts nothing", async () => {
    const w = await world();
    await w.inbox.pollOnce();
    await new Promise((r) => setTimeout(r, 20));
    const card = await slackCard(w.pipeline);
    const row = [...w.store.rows.values()][0]!;
    await w.store.save([{ ...row, linked: { ...row.linked, taskId: card.id } }]);
    const kinds: Array<[string, Record<string, unknown>]> = [
      ["transition", { from: "draft", to: "triage", event: "start" }],
      ["transition", { from: "triage", to: "escalated", reason: "stuck" }],
      ["transition", { from: "triage", to: "closed" }],
      ["transition", { from: "triage", to: "archived", archiveReason: "stale" }],
      ["transition", { from: "triage", to: "awaiting_approval" }],
      ["task.questions", { body: "Which export?", secret: false, hash: "h", by: "machine" }],
      ["task.reply", { body: "Done.", by: "machine" }],
      ["task.shipped", { title: "Checkout fails", prUrl: "https://github.com/o/a/pull/4", number: 4, mergedSha: null, by: "machine", format: null, howToVerify: null, media: [] }],
      ["stage.finished", { detail: { prUrl: "https://github.com/o/a/pull/4" } }],
    ];
    for (const [kind, payload] of kinds) await w.replies.handle(event(card.id, kind, payload));
    await w.replies.idle();
    expect(w.writes()).toEqual([]);
    expect(w.fetched).toEqual([]);
    const outbound = (await w.drafts.allWaiting()).filter((d) => d.kind !== "reply");
    expect(outbound.length).toBeGreaterThan(0);
    expect(outbound.every((d) => d.thread === row.id)).toBe(true);
  });

  it("gives a card with no conversation a conversation.undeliverable event and no draft", async () => {
    const w = await world();
    const card = await slackCard(w.pipeline);
    await w.replies.handle(event(card.id, "task.shipped", { title: "t", prUrl: "https://github.com/o/a/pull/4", number: 4, mergedSha: null, by: "machine", format: null, howToVerify: null, media: [] }));
    await w.replies.idle();
    expect(w.writes()).toEqual([]);
    expect((await w.pipeline.events(card.id)).some((e) => e.kind === "conversation.undeliverable")).toBe(true);
    expect(await w.drafts.allWaiting()).toEqual([]);
  });
});

describe("with conversation.auto: on the writes of today happen", () => {
  it("opens the machine-owned thread and posts the shipped summary to the source thread", async () => {
    const w = await world({ auto: "on" });
    const card = await slackCard(w.pipeline);
    await w.replies.handle(event(card.id, "transition", { from: "draft", to: "triage", event: "start" }));
    await w.replies.handle(event(card.id, "task.shipped", { title: "t", prUrl: "https://github.com/o/a/pull/4", number: 4, mergedSha: null, by: "machine", format: null, howToVerify: null, media: [] }));
    await w.replies.idle();
    expect(w.fetched.length).toBeGreaterThan(0);
    expect(w.writes().map((c) => c[0])).toContain("postMessage");
  });
});


describe("each tap makes exactly one write, recorded with its route", () => {
  const ready = async () => {
    const w = await world();
    await w.inbox.pollOnce();
    await new Promise((r) => setTimeout(r, 20));
    const row = [...w.store.rows.values()][0]!;
    return { ...w, row, id: row.id };
  };
  it("POST /slack/items/:id/reply posts once, in the thread, and settles the waiting draft", async () => {
    const w = await ready();
    await w.inbox.reply(w.id, "It is queued.", tapOf("POST /slack/items/:id/reply"));
    expect(w.sender.writes).toEqual([{ method: "postMessage", channel: "C1", by: "POST /slack/items/:id/reply" }]);
    expect(w.writes()).toHaveLength(1);
    expect(await w.drafts.waiting(w.id)).toBeNull();
  });
  it("two taps in flight post once: the second finds the draft already claimed", async () => {
    const w = await ready();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    let posts = 0;
    (w.slack.postMessage as unknown as { mockImplementation: (f: () => Promise<string>) => void }).mockImplementation(async () => (posts++, await gate, "9.9"));
    const first = w.inbox.reply(w.id, "It is queued.", tapOf("POST /slack/items/:id/reply"));
    await new Promise((r) => setTimeout(r, 10));
    const second = w.inbox.reply(w.id, "It is queued.", tapOf("POST /slack/items/:id/reply"));
    await expect(second).rejects.toBeInstanceOf(SlackRefusedError);
    release();
    await first;
    expect(posts).toBe(1);
  });
  it("a failed post gives the claim back: the draft waits again and the message did not go out", async () => {
    const w = await ready();
    (w.slack.postMessage as unknown as { mockImplementation: (f: () => Promise<string>) => void }).mockImplementation(async () => {
      throw new Error("slack is down");
    });
    await expect(w.inbox.reply(w.id, "It is queued.", tapOf("POST /slack/items/:id/reply"))).rejects.toThrow("slack is down");
    expect((await w.drafts.waiting(w.id))?.text).toBe("It is queued.");
  });
  it("PATCH done marks Slack read once when mark-read is on", async () => {
    const w = await ready();
    await w.inbox.patch(w.id, { done: true }, tapOf("PATCH /slack/items/:id"));
    expect(w.sender.writes).toEqual([{ method: "mark", channel: "C1", by: "PATCH /slack/items/:id" }]);
  });
  it("POST /slack/items/:id/task makes exactly one card, and nothing else makes one", async () => {
    const w = await ready();
    expect(w.created).toEqual([]);
    await w.inbox.toTask(w.id, {}, tapOf("POST /slack/items/:id/task"));
    expect(w.created).toHaveLength(1);
    expect(w.writes()).toEqual([]);
  });
  it("a person's questions or approved reply on the card posts once, through the event's own stamp, in the thread's root", async () => {
    const w = await ready();
    const card = await slackCard(w.pipeline);
    await w.store.save([{ ...w.row, linked: { ...w.row.linked, taskId: card.id } }]);
    await w.replies.handle(event(card.id, "task.questions", { body: "Which export?", secret: false, hash: "h", by: "person" }));
    await w.replies.handle(event(card.id, "task.reply", { body: "Done.", by: "person" }));
    await w.replies.idle();
    expect(w.sender.writes.map((x) => x.by)).toEqual(["event task.questions", "event task.reply"]);
    expect((w.slack.calls as unknown[][]).filter((c) => c[0] === "postMessage").every((c) => c[3] === w.id.split(":")[1])).toBe(true);
    expect(w.fetched).toEqual([]);
  });
  it("a machine-stamped questions or reply is a draft, not a post", async () => {
    const w = await ready();
    const card = await slackCard(w.pipeline);
    await w.store.save([{ ...w.row, linked: { ...w.row.linked, taskId: card.id } }]);
    await w.replies.handle(event(card.id, "task.questions", { body: "Which export?", secret: false, hash: "h", by: "machine" }));
    await w.replies.idle();
    expect(w.sender.writes).toEqual([]);
    expect((await w.drafts.waiting(w.id))?.kind).toBe("questions");
  });
  it("the tap that posts the questions settles the waiting questions draft: it is not left to expire or to be sent a second time", async () => {
    const w = await ready();
    const card = await slackCard(w.pipeline);
    await w.store.save([{ ...w.row, linked: { ...w.row.linked, taskId: card.id } }]);
    await w.replies.handle(event(card.id, "task.questions", { body: "Which export?", secret: false, hash: "h", by: "machine" }));
    await w.replies.idle();
    const draft = (await w.drafts.waiting(w.id))!;
    expect(draft.kind).toBe("questions");
    await w.replies.handle(event(card.id, "task.questions", { body: "Which export?", secret: false, hash: "h", by: "person" }));
    await w.replies.idle();
    expect(w.sender.writes).toHaveLength(1);
    expect(await w.drafts.waiting(w.id)).toBeNull();
    expect((await w.drafts.get(draft.id))?.status).toBe("sent");
  });
  it("a text that carries a secret-shaped string is refused at the door", async () => {
    const w = await ready();
    const token = ["gh", "p_", "a".repeat(36)].join("");
    await expect(w.sender.postMessage(tapOf("x"), "C1", `use ${token}`)).rejects.toBeInstanceOf(SlackRefusedError);
    expect(w.writes()).toEqual([]);
  });
});

describe("the digest is the one named clock that writes", () => {
  it("posts only to the operator's own DM, and only when MACHINE_SLACK_DIGEST_AT is set", async () => {
    const w = await world();
    await w.inbox.pollOnce();
    await w.inbox.postDigest();
    expect(w.sender.writes.map((x) => [x.method, x.by])).toEqual([["openDm", "digest"], ["postMessage", "digest"]]);
    expect(w.sender.writes.map((x) => x.channel)).toEqual(["U1", "D1"]);
    expect(standingOf({})).toBeNull();
  });
});
