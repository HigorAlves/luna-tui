import type { DataSource } from "typeorm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { canonicalMessageOf, emptyConversation, foldMessage } from "../domain/conversation.ts";
import type { SlackItemRow } from "../domain/slack-item.ts";
import { freshTestDatabase } from "../test/database.ts";
import { type EnrichDeps, enrichConversation } from "./conversation-enrich.ts";
import { Pipeline } from "./pipeline.ts";
import { StubStages } from "./stages/stubs.ts";

const NOW = new Date("2026-10-28T12:00:00Z");
const j = (...p: string[]) => p.join("");

function row(over: { kind?: "channel" | "dm"; texts?: string[]; repo?: string | null; authorId?: string; threadTs?: string | null } = {}): SlackItemRow {
  const channel = { id: over.kind === "dm" ? "D1" : "C1", name: over.kind === "dm" ? "ana" : "eng", kind: over.kind ?? "channel" } as const;
  let conversation = emptyConversation(channel, over.repo ?? null);
  (over.texts ?? ["the export fails"]).forEach((text, i) => {
    const author = { id: over.authorId ?? "U2", name: "marta", isBot: false };
    conversation = foldMessage(conversation, canonicalMessageOf({ ts: `17000000${String(i).padStart(2, "0")}.000000`, user: author.id, botId: null, text, subtype: null, threadTs: "1700000000.000000", replyCount: 0, latestReply: null }, { channel, author, permalink: "https://x.slack.com/p1" }));
  });
  return { id: "C1:1700000000.000000", kind: "mention", channel, author: { id: "U2", name: "marta", isBot: false }, text: "the export fails", threadTs: null, context: [], permalink: "https://x.slack.com/p1", ts: NOW.toISOString(), slackTs: "1700000000.000000", matched: [], count: 1, replies: 0, youReplied: false, seenAt: null, doneAt: null, snoozedUntil: null, reopenedAt: null, repliedAt: null, arrivedAt: NOW.toISOString(), triage: null, linked: { pr: null, taskId: null }, conversation } as SlackItemRow;
}

const deps = (over: Partial<EnrichDeps> = {}): EnrichDeps => ({
  userInfo: async () => ({ id: "U2", name: "marta", isBot: false, isGuest: false, title: "Engineer" }),
  isVip: () => false,
  candidates: async () => [],
  claimedCandidates: async () => [],
  claimedBy: () => null,
  ...over,
});

describe("enrichConversation", () => {
  it("builds the thread as author: text lines, masks e-mail addresses and phone numbers, flattens and caps", async () => {
    const long = `x${"y".repeat(800)}`;
    const { context } = await enrichConversation(row({ texts: ["write to ana@example.com\nor +1 415-555-0132", long] }), deps(), NOW);
    expect(context.thread[0]).toBe("marta: write to [email] or [phone]");
    expect(context.thread[1]!.length).toBeLessThanOrEqual("marta: ".length + 500);
    expect(context.latest.length).toBeLessThanOrEqual(500);
    expect(context.channel).toBe("eng");
    expect(context.private).toBe(false);
  });

  it("keeps at most twenty lines", async () => {
    const { context } = await enrichConversation(row({ texts: Array.from({ length: 30 }, (_, i) => `m${i}`) }), deps(), NOW);
    expect(context.thread).toHaveLength(20);
  });

  it("reads the author's profile: bot, guest, vip, else member, with the title", async () => {
    const profile = async (info: Partial<{ isBot: boolean; isGuest: boolean }>, vip = false) => (await enrichConversation(row(), deps({ userInfo: async () => ({ id: "U2", name: "marta", isBot: false, isGuest: false, title: "CTO", ...info }), isVip: () => vip }), NOW)).context.author;
    expect(await profile({ isBot: true })).toEqual({ profile: "bot", title: "CTO" });
    expect(await profile({ isGuest: true })).toMatchObject({ profile: "guest" });
    expect(await profile({}, true)).toMatchObject({ profile: "vip" });
    expect(await profile({})).toEqual({ profile: "member", title: "CTO" });
  });

  it("is a member with no title when the profile cannot be read", async () => {
    const { context } = await enrichConversation(row(), deps({ userInfo: async () => { throw new Error("ratelimited"); } }), NOW);
    expect(context.author).toEqual({ profile: "member", title: null });
  });

  it("gets no candidates for a conversation with no repository, and asks for them by the thread's own source otherwise", async () => {
    const asked: unknown[] = [];
    const candidates = async (repo: string | null, source: unknown) => (asked.push([repo, source]), [{ id: "t1", kind: "open" as const, title: "Export fails", text: "csv export fails", repo: "/r/a", closedAt: null }]);
    expect((await enrichConversation(row({ repo: null }), deps({ candidates }), NOW)).context.candidates).toEqual([]);
    const out = await enrichConversation(row({ repo: "/r/a" }), deps({ candidates }), NOW);
    expect(asked).toEqual([["/r/a", { kind: "slack", channel: "C1", ts: "1700000000.000000", permalink: "https://x.slack.com/p1" }]]);
    expect(out.context.candidates).toEqual([{ slot: 1, kind: "open", title: "Export fails", summary: "csv export fails" }]);
    expect(out.shortlist).toMatchObject([{ slot: 1, id: "t1", kind: "open", otherSource: null }]);
  });

  it("adds a ticket-sourced card of the repository only in a channel the repository claims, and marks where it came from", async () => {
    const claimedCandidates = async () => [{ id: "t9", kind: "open" as const, title: "Export fails for big files", text: "the export fails", repo: "/r/a", closedAt: null, otherSource: { kind: "jira" as const, key: "PAY-9" } }];
    const claimed = await enrichConversation(row({ repo: "/r/a" }), deps({ claimedCandidates, claimedBy: () => "/r/a" }), NOW);
    expect(claimed.shortlist).toMatchObject([{ slot: 1, id: "t9", kind: "open", otherSource: { kind: "jira", key: "PAY-9" } }]);
    const watched = await enrichConversation(row({ repo: "/r/a" }), deps({ claimedCandidates, claimedBy: () => null }), NOW);
    expect(watched.shortlist).toEqual([]);
  });

  it("shortlists at most five by similarity", async () => {
    const candidates = async () => Array.from({ length: 9 }, (_, i) => ({ id: `t${i}`, kind: "open" as const, title: i < 6 ? `export fails ${i}` : `unrelated thing ${i}`, text: "", repo: "/r/a", closedAt: null }));
    const { context, shortlist } = await enrichConversation(row({ repo: "/r/a" }), deps({ candidates }), NOW);
    expect(context.candidates).toHaveLength(5);
    expect(shortlist.every((s) => Number(s.id.slice(1)) < 6)).toBe(true);
  });

  it("treats a failing candidate port as an empty answer", async () => {
    const { context } = await enrichConversation(row({ repo: "/r/a" }), deps({ candidates: async () => { throw new Error("db down"); } }), NOW);
    expect(context.candidates).toEqual([]);
  });

  it("marks a private conversation and never puts a token in the context", async () => {
    const token = j("gh", "p_", "C".repeat(24));
    const out = await enrichConversation(row({ kind: "dm", texts: [`my key ${token}`] }), deps(), NOW);
    expect(out.context.private).toBe(true);
    expect(JSON.stringify(out.context)).not.toContain(token);
  });
});

let db: DataSource;
const stubs = new StubStages();
beforeAll(async () => {
  db = await freshTestDatabase();
});
afterAll(async () => {
  await db.destroy();
});
beforeEach(async () => {
  await db.query("truncate tasks cascade");
});

describe("Pipeline.claimedRepoCandidates", () => {
  it("holds the repository's cards whose first source is a Jira or GitHub ticket, never another Slack thread, a DM or no source", async () => {
    const pipeline = new Pipeline(db, stubs.runnerFor, { inline: true, hasConfig: () => true });
    const make = (title: string, extra: Record<string, unknown>) => pipeline.createTask({ title, repoPath: "/r/a", ...extra } as never);
    const jira = await make("from jira", { source: { kind: "jira", key: "PAY-9", url: "https://j/PAY-9", issueType: "Bug" } });
    const issue = await make("from issue", { source: { kind: "github", repo: "o/a", number: 4, url: "https://github.com/o/a/issues/4" } });
    await make("from slack", { source: { kind: "slack", channel: "C2", ts: "1.0", permalink: "p" } });
    await make("no source", {});
    await pipeline.createTask({ title: "other repo", repoPath: "/r/b", source: { kind: "jira", key: "OTH-1", url: "u", issueType: null } });
    const found = await pipeline.claimedRepoCandidates("/r/a");
    expect(found.map((c) => c.id).sort()).toEqual([jira.id, issue.id].sort());
    expect(found.find((c) => c.id === jira.id)?.otherSource).toEqual({ kind: "jira", key: "PAY-9" });
    expect(found.find((c) => c.id === issue.id)?.otherSource).toEqual({ kind: "github", key: "o/a#4" });
  });
});

describe("the shortlist the board shows", () => {
  it("carries a flattened, capped title per slot, only for candidates that passed the audience filter", async () => {
    const long = `Export fails ${"z".repeat(400)}\nsecond line ana@example.com`;
    const near = { id: "c1", kind: "open" as const, title: long, text: "the export fails with a timeout", repo: "/r", closedAt: null };
    const hidden = { id: "c2", kind: "open" as const, title: "export fails elsewhere", text: "the export fails with a timeout", repo: "/r", closedAt: null };
    const out = await enrichConversation(row({ repo: "/r" }), deps({ candidates: async () => [near] }), NOW);
    void hidden;
    expect(out.shortlist).toHaveLength(1);
    expect(out.shortlist[0]!.title.length).toBeLessThanOrEqual(120);
    expect(out.shortlist[0]!.title).not.toMatch(/\n|@example/);
    expect(out.shortlist.map((e) => e.id)).toEqual(["c1"]);
  });
});
