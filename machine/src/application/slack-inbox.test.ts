import { type ConversationRelation, FACTORY_DEFAULTS, type SlackPriority, type SlackSnapshot } from "@hardness/contracts";
import { describe, expect, it, vi } from "vitest";

import type { SlackItemRow } from "../domain/slack-item.ts";
import { carriesSecret, postable, postableKeeping } from "../domain/postable.ts";
import { RULES_TEMPLATE } from "../domain/slack-rules.ts";
import type { TaskRow } from "../domain/task.ts";
import { MemorySlackStore, fakeSlack } from "../test/slack.ts";
import { tapOf } from "./slack-send.ts";
import { ChannelClaims } from "./channel-claims.ts";
import { ConversationActions } from "./conversation-actions.ts";
import { ConversationDrafts, draftHash, MemoryDraftStore } from "./conversation-drafts.ts";
import type { Assessed } from "./conversation-machine.ts";
import { AlreadyTaskError, BadRelationError, BuiltinWatchError, NoItemError, SlackInbox, SlackRefusedError } from "./slack-inbox.ts";
import { NoSlackTokenError, type RawMessage, type SearchHit, noTokenSlack } from "./slack.ts";
import type { TriageAnswer, TriageItem, Triager } from "./slack-triage.ts";

const NOW = new Date("2026-10-28T12:00:00Z");
/** A Slack ts `minutes` before NOW. */
const ts = (minutes: number): string => ((NOW.getTime() - minutes * 60_000) / 1000).toFixed(6);
const iso = (minutes: number): string => new Date(NOW.getTime() - minutes * 60_000).toISOString();
/** A poll and the triage it queued: the snapshot once the verdicts have landed. */
const poll = async (inbox: SlackInbox): Promise<SlackSnapshot> => {
  await inbox.pollOnce();
  await inbox.idle();
  return inbox.snapshot;
};

const USERS: Record<string, { name: string; isBot: boolean }> = { U1: { name: "higor", isBot: false }, U2: { name: "marta", isBot: false }, U3: { name: "ana", isBot: false }, UB: { name: "deploybot", isBot: true } };
const CHANNELS: Record<string, { name: string; kind: "channel" | "group" | "dm" | "mpim" }> = { C1: { name: "eng", kind: "channel" }, C9: { name: "payments-oncall", kind: "channel" }, CR: { name: "random", kind: "channel" }, D1: { name: "U2", kind: "dm" }, G1: { name: "secret", kind: "group" } };

interface World {
  hits?: SearchHit[];
  history?: Record<string, RawMessage[]>;
  replies?: Record<string, RawMessage[]>;
  searchError?: string;
  answer?: (item: TriageItem) => TriageAnswer | null;
  rules?: string | null;
  markRead?: boolean;
  triager?: Triager | null;
  linkPr?: SlackInbox["snapshot"]["items"][number]["linked"]["pr"];
  now?: () => Date;
  intervalMs?: number;
  retentionDays?: number;
  scope?: "opted_in" | "all";
  claimed?: Record<string, string>;
  conv?: Partial<typeof FACTORY_DEFAULTS.conversation>;
  assessor?: { assess: (row: SlackItemRow) => Promise<Assessed> };
  drafter?: { draft: (row: SlackItemRow, onRefused?: (why: string) => void) => Promise<string | null> };
  drafts?: ConversationDrafts;
  cardAddress?: (cardId: string) => Promise<string | null>;
  actions?: { apply: (row: SlackItemRow, relation: ConversationRelation) => Promise<{ relation: ConversationRelation; taskId?: string; priority?: SlackPriority }>; undo: (previous: ConversationRelation | null | undefined, next: ConversationRelation) => Promise<void> };
  truth?: { override: (input: unknown) => Promise<void>; relation?: (input: unknown) => Promise<void>; outcome?: (input: unknown) => Promise<void> };
}

const TAP = tapOf("test");
const msg = (over: Partial<RawMessage> & { ts: string }): RawMessage => ({ user: "U2", botId: null, text: "", subtype: null, threadTs: null, replyCount: 0, latestReply: null, ...over });
const hit = (over: Partial<SearchHit> & { ts: string }): SearchHit => ({ text: "<@U1> hi", user: "U2", channel: { id: "C1", name: "eng" }, permalink: `https://x.slack.com/archives/C1/p${over.ts.replace(".", "")}`, ...over });

const stubClaims = (byChannel: Record<string, string>, conv: Partial<typeof FACTORY_DEFAULTS.conversation> = {}): ChannelClaims => {
  const c = new ChannelClaims(async () => [], async () => ({ conversation: FACTORY_DEFAULTS.conversation, scoring: FACTORY_DEFAULTS.scoring }));
  Object.assign(c, { refresh: async () => {}, repoOf: (ch: string) => byChannel[ch] ?? null, configOf: () => ({ conversation: { ...FACTORY_DEFAULTS.conversation, ...conv }, scoring: FACTORY_DEFAULTS.scoring }), claimed: () => new Set(Object.keys(byChannel)) });
  return c;
};

const answerAll = (item: TriageItem): TriageAnswer => ({
  priority: "P1",
  category: "question",
  expectsReply: /\?/.test(item.text),
  summary: `re: ${item.text.slice(0, 20)}`,
  why: "asked",
  draft: /\?/.test(item.text) ? "On it." : null,
  refs: [],
  deadline: null,
});

function setup(world: World = {}) {
  const slack = fakeSlack({
    me: async () => ({ id: "U1", name: "higor" }),
    searchMentions: async () => {
      if (world.searchError) throw new Error(world.searchError);
      return { hits: world.hits ?? [], nextCursor: null };
    },
    conversations: async (types) => (types.includes("im") ? [{ id: "D1", name: "U2", kind: "dm" as const }] : [{ id: "C1", name: "eng", kind: "channel" as const }, { id: "C9", name: "payments-oncall", kind: "channel" as const }, { id: "CR", name: "random", kind: "channel" as const }]),
    history: async (channel) => world.history?.[channel] ?? [],
    replies: async (channel, threadTs) => world.replies?.[`${channel}:${threadTs}`] ?? [],
    usergroups: async () => [{ id: "S1", handle: "platform-team", name: "Platform" }],
    userInfo: async (id) => ({ id, ...(USERS[id] ?? { name: id, isBot: false }) }),
    channelInfo: async (id) => ({ id, ...(CHANNELS[id] ?? { name: id, kind: "channel" as const }) }),
    permalink: async (channel, t) => `https://x.slack.com/archives/${channel}/p${t.replace(".", "")}`,
    postMessage: async () => ts(0),
    mark: async () => {},
    openDm: async () => "D1",
  });
  const store = new MemorySlackStore();
  const published: SlackSnapshot[] = [];
  const triaged: TriageItem[][] = [];
  const triager: Triager | null =
    world.triager === undefined
      ? {
          triage: async (items) => {
            triaged.push(items);
            const answers = new Map<string, TriageAnswer>();
            for (const item of items) {
              const a = (world.answer ?? answerAll)(item);
              if (a) answers.set(item.id, a);
            }
            return answers;
          },
        }
      : world.triager;
  const files = new Map<string, string>();
  if (world.rules !== null) files.set("/rules.md", world.rules ?? RULES_TEMPLATE);
  const created: unknown[] = [];
  const tasks = new Map<string, TaskRow>();
  const inbox = new SlackInbox({
    slack,
    triager,
    store,
    intervalMs: world.intervalMs ?? 60_000,
    publish: (s) => void published.push(s),
    findTask: async (id) => tasks.get(id) ?? null,
    linkPr: () => world.linkPr ?? null,
    createTask: async (input) => {
      created.push(input);
      const task = { id: `task-${created.length}`, title: input.title, state: "draft" } as unknown as TaskRow;
      tasks.set(task.id, task);
      return task;
    },
    markRead: world.markRead ?? false,
    scope: world.scope ?? "all",
    ...(world.claimed || world.conv ? { claims: stubClaims(world.claimed ?? {}, world.conv) } : {}),
    ...(world.assessor ? { assessor: world.assessor } : {}),
    ...(world.actions ? { actions: world.actions } : {}),
    ...(world.drafter ? { drafter: world.drafter } : {}),
    ...(world.drafts ? { drafts: world.drafts } : {}),
    ...(world.cardAddress ? { cardAddress: world.cardAddress } : {}),
    digest: true,
    ...(world.truth ? { truth: world.truth as never } : {}),
    rulesPath: "/rules.md",
    socketToken: null,
    now: world.now ?? (() => NOW),
    files: { read: async (p) => files.get(p) ?? null, write: async (p, t) => void files.set(p, t) },
    ...(world.retentionDays !== undefined ? { retentionDays: world.retentionDays } : {}),
  });
  return { inbox, slack, store, published, triaged, files, created };
}

describe("SlackInbox.pollOnce", () => {
  it("turns mentions into triaged items with the builtin watches, publishes the poll and then the verdicts, then only on change", async () => {
    const { inbox, published, triaged, slack } = setup({ hits: [hit({ ts: ts(10), text: "<@U1> can you review https://github.com/o/a/pull/212?" })], linkPr: { repo: "o/a", number: 212, split: "review_requested" } });
    // The poll publishes at once, before the pack runs; the verdicts are a second publish.
    const polled = await inbox.pollOnce();
    expect(polled.items[0]!.triage).toBeNull();
    expect(published).toHaveLength(1);
    await inbox.idle();
    const snapshot = inbox.snapshot;
    expect(snapshot.error).toBeNull();
    expect(snapshot.me).toEqual({ id: "U1", name: "higor", isBot: false });
    expect(snapshot.socket).toBe("off");
    expect(snapshot.watches.map((w) => [w.kind, w.value, w.builtin])).toEqual([["broadcast", "here", true], ["broadcast", "channel", true], ["broadcast", "everyone", true]]);
    expect(snapshot.items).toHaveLength(1);
    const item = snapshot.items[0]!;
    expect(item).toMatchObject({
      id: `C1:${ts(10)}`,
      kind: "mention",
      channel: { id: "C1", name: "eng", kind: "channel" },
      author: { id: "U2", name: "marta", isBot: false },
      text: "@higor can you review https://github.com/o/a/pull/212?",
      matched: ["me"],
      count: 1,
      split: "needs_reply",
      triage: { priority: "P1", expectsReply: true, by: "model", draft: "On it.", overridden: false },
      linked: { pr: { repo: "o/a", number: 212 }, taskId: null },
    });
    expect(triaged[0]![0]).toMatchObject({ id: item.id, channel: "#eng", author: "@marta", matched: ["me"], isBot: false, threadReplies: 0 });
    expect(published).toHaveLength(2);
    await poll(inbox);
    expect(published).toHaveLength(2);
    // The second poll searches since the newest hit.
    const searches = slack.calls.filter((c) => c[0] === "searchMentions");
    expect(searches[1]![2]).toBe(ts(10));
  });

  it("stores no token shape: a message, a reply and a reaction are screened before the row is saved", async () => {
    const token = ["xox", "b-", "1234567890-abcdefghij"].join("");
    const key = ["gh", "p_", "B".repeat(24)].join("");
    const { inbox, store } = setup({
      hits: [hit({ ts: ts(30), text: `<@U1> deploy failed, token ${token}` })],
      replies: { [`C1:${ts(30)}`]: [msg({ ts: ts(20), user: "U3", text: `<@U1> also ${key}`, threadTs: ts(30) })] },
    });
    await poll(inbox);
    await poll(inbox);
    const rows = [...store.rows.values()];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(carriesSecret(row.text)).toBe(false);
      for (const c of row.context) expect(carriesSecret(c.text)).toBe(false);
      expect(JSON.stringify(row)).not.toContain(token);
      expect(JSON.stringify(row)).not.toContain(key);
    }
    expect(rows[0]!.text).toContain("[redacted]");
  });

  it("folds every message it reads of a thread into the item's conversation: the ingest and the replies", async () => {
    const root = ts(40);
    const { inbox, store } = setup({
      hits: [hit({ ts: root, text: "<@U1> the export fails" })],
      replies: { [`C1:${root}`]: [msg({ ts: ts(30), user: "U3", text: "same here, mail ana@example.com", threadTs: root, files: [{ id: "F1", name: "trace.log", kind: "text" }] })] },
    });
    await poll(inbox);
    await poll(inbox);
    const row = store.rows.get(`C1:${root}`)!;
    expect(row.conversation?.private).toBe(false);
    expect(row.conversation?.history.map((m) => m.id)).toEqual([`C1:${root}`, `C1:${ts(30)}`]);
    expect(row.conversation?.history[1]!.attachments).toEqual([{ id: "F1", name: "trace.log", kind: "text" }]);
    expect(row.conversation?.participants.map((p) => p.id).sort()).toEqual(["U2", "U3"]);
    expect(row.conversation?.pii).toEqual(["email"]);
    await poll(inbox);
    expect(store.rows.get(`C1:${root}`)!.conversation?.history).toHaveLength(2);
  });

  it("marks a DM's conversation private", async () => {
    const { inbox, store } = setup({ history: { D1: [msg({ ts: ts(5), text: "ping" })] } });
    await poll(inbox);
    expect(store.rows.get(`D1:${ts(5)}`)!.conversation?.private).toBe(true);
  });

  it("applies an edit and a deletion that arrive over the socket at the next poll, and triages the item again when it was the latest message", async () => {
    const root = ts(40);
    const { inbox, store, triaged } = setup({
      hits: [hit({ ts: root, text: "<@U1> the export fails?" })],
      replies: { [`C1:${root}`]: [] },
    });
    await poll(inbox);
    const before = triaged.length;
    inbox.handleSocketEvent({ type: "message", channel: "C1", ts: ts(1), subtype: "message_changed", message: { ts: root, text: "<@U1> the import fails?" } });
    await poll(inbox);
    const edited = store.rows.get(`C1:${root}`)!;
    expect(edited.conversation?.history[0]).toMatchObject({ text: "@higor the import fails?" });
    expect(edited.conversation?.history[0]!.editedAt).not.toBeNull();
    expect(edited.text).toBe("@higor the import fails?");
    expect(triaged.length).toBeGreaterThan(before);
    inbox.handleSocketEvent({ type: "message", channel: "C1", ts: ts(0.5), subtype: "message_deleted", deleted_ts: root });
    await poll(inbox);
    const gone = store.rows.get(`C1:${root}`)!;
    expect(gone.conversation?.history[0]).toMatchObject({ deleted: true, text: "" });
    expect(gone.text).toBe("");
  });

  it("without the socket, the replies re-read finds an edit and a deletion", async () => {
    const root = ts(40);
    const state = { replies: [msg({ ts: ts(30), user: "U3", text: "first", threadTs: root }), msg({ ts: ts(20), user: "U3", text: "second", threadTs: root })] };
    const { inbox, store } = setup({ hits: [hit({ ts: root, text: "<@U1> help" })], replies: { [`C1:${root}`]: state.replies } });
    await poll(inbox);
    state.replies.splice(0, 2, msg({ ts: ts(30), user: "U3", text: "first, fixed", threadTs: root, editedTs: ts(25) }));
    await poll(inbox);
    const history = store.rows.get(`C1:${root}`)!.conversation!.history;
    expect(history.find((m) => m.id === `C1:${ts(30)}`)).toMatchObject({ text: "first, fixed" });
    expect(history.find((m) => m.id === `C1:${ts(20)}`)).toMatchObject({ deleted: true, text: "" });
  });

  describe("scope", () => {
    const called = (slack: ReturnType<typeof setup>["slack"], method: string) => slack.calls.filter((c) => c[0] === method);
    const world = (over: World = {}): World => ({
      scope: "opted_in",
      hits: [hit({ ts: ts(10), text: "<@U1> in a channel nobody opted in" })],
      history: { D1: [msg({ ts: ts(5), text: "ping from a DM" })], CR: [msg({ ts: ts(4), text: "<@U1> in random" })], C1: [msg({ ts: ts(3), text: "<@U1> in eng" })] },
      ...over,
    });

    it("reads nothing nobody opted in: no search, no DM sweep, no history, no replies, no row, no pack run", async () => {
      const { inbox, slack, store, triaged } = setup(world());
      const snapshot = await poll(inbox);
      expect(called(slack, "searchMentions")).toEqual([]);
      expect(slack.calls.filter((c) => c[0] === "conversations" && (c[1] as string[]).includes("im"))).toEqual([]);
      expect(called(slack, "history")).toEqual([]);
      expect(called(slack, "replies")).toEqual([]);
      expect(store.rows.size).toBe(0);
      expect(triaged).toEqual([]);
      expect(snapshot.scope).toBe("opted_in");
      expect(snapshot.optedIn).toBe(0);
    });

    it("sweeps a channel with a channel watch, a channel a repository claims and a DM opted in by its id, and no other", async () => {
      const { inbox, slack, store } = setup(world({ claimed: { CR: "/repos/a", D1: "/repos/a" } }));
      await inbox.addWatch({ kind: "channel", value: "C1", channels: [], priority: null });
      const snapshot = await poll(inbox);
      expect(called(slack, "history").map((c) => c[1]).sort()).toEqual(["C1", "CR", "D1"]);
      expect(called(slack, "searchMentions")).toEqual([]);
      expect([...store.rows.keys()].sort()).toEqual([`C1:${ts(3)}`, `CR:${ts(4)}`, `D1:${ts(5)}`]);
      expect(snapshot.optedIn).toBe(3);
      expect(store.rows.get(`CR:${ts(4)}`)!.conversation?.repo).toBe("/repos/a");
      expect(store.rows.get(`C1:${ts(3)}`)!.conversation?.repo).toBeNull();
    });

    it("drops a socket event from a conversation out of scope and re-reads only tracked threads in scope", async () => {
      const { inbox, slack, store } = setup(world({ claimed: { C1: "/repos/a" } }));
      const row = (channel: string, name: string) => ({ id: `${channel}:${ts(60)}`, kind: "mention", channel: { id: channel, name, kind: "channel" }, author: { id: "U2", name: "marta", isBot: false }, text: "old", threadTs: null, context: [], permalink: "", ts: iso(60), slackTs: ts(60), matched: ["me"], count: 1, replies: 0, youReplied: false, seenAt: null, doneAt: null, snoozedUntil: null, reopenedAt: null, repliedAt: null, arrivedAt: iso(60), triage: null, linked: { pr: null, taskId: null } }) as SlackItemRow;
      await store.save([row("C1", "eng"), row("C9", "payments-oncall")]);
      await inbox.pollOnce();
      inbox.handleSocketEvent({ type: "message", channel: "C9", ts: ts(1), user: "U2", text: "x" });
      await inbox.pollOnce(true);
      expect(called(slack, "replies").length).toBeGreaterThan(0);
      expect(called(slack, "replies").every((c) => c[1] === "C1")).toBe(true);
      expect(called(slack, "history").map((c) => c[1])).not.toContain("C9");
      expect(store.rows.has(`C9:${ts(60)}`)).toBe(true);
    });
  });

  describe("the conversation chain", () => {
    const assessed = (over: Partial<Assessed> = {}): Assessed => ({
      triage: { priority: "P1", category: "request", expectsReply: true, summary: "s", why: "bug; who 1", draft: null, refs: [], deadline: null, by: "model", triagedAt: iso(0), overridden: false },
      classification: { kind: "bug", confidence: 0.9, by: "model", at: iso(0), records: { assess: "rec-1" }, verdict: "ok" },
      verdict: "ok",
      relation: null,
      shortlist: [],
      ...over,
    });
    const chain = (over: World = {}) => {
      const calls: string[] = [];
      const assessor = { assess: async (row: SlackItemRow) => (calls.push(row.id), assessed()) };
      return { calls, ...setup({ assessor, hits: [hit({ ts: ts(10), text: "<@U1> it breaks" })], ...over }) };
    };

    it("runs the new chain for a repository with conversation.auto off, not the slack_triage pack", async () => {
      const { inbox, store, calls, triaged } = chain();
      await poll(inbox);
      expect(calls).toEqual([`C1:${ts(10)}`]);
      expect(triaged).toEqual([]);
      const row = store.rows.get(`C1:${ts(10)}`)!;
      expect(row.triage).toMatchObject({ priority: "P1", by: "model" });
      expect(row.conversation?.classification).toMatchObject({ kind: "bug", records: { assess: "rec-1" } });
    });

    it("keeps the slack_triage pack, with its inline draft, for a repository with conversation.auto on", async () => {
      const { inbox, calls, triaged } = chain({ conv: { auto: "on" } });
      await poll(inbox);
      expect(calls).toEqual([]);
      expect(triaged).toHaveLength(1);
    });

    it("waits for the thread to be quiet for the debounce, unless the message mentions the person", async () => {
      let nowMs = NOW.getTime();
      const calls: string[] = [];
      const assessor = { assess: async (row: SlackItemRow) => (calls.push(row.id), assessed()) };
      const { inbox } = setup({ assessor, now: () => new Date(nowMs), scope: "opted_in", history: { C1: [msg({ ts: ts(0.5), text: "anyone seen this fail?" })] }, claimed: { C1: "/r" }, conv: { debounce_seconds: 90 } });
      await inbox.pollOnce();
      await inbox.idle();
      expect(calls).toEqual([]);
      nowMs += 120_000;
      await inbox.pollOnce(true);
      await inbox.idle();
      inbox.tick();
      await inbox.idle();
      expect(calls).toEqual([`C1:${ts(0.5)}`]);
      const mention = setup({ assessor, hits: [hit({ ts: ts(0.1), text: "<@U1> urgent" })] });
      await poll(mention.inbox);
      expect(calls).toHaveLength(2);
    });

    it("lists an unsure verdict with the machine's guess and waits for the person: PATCH kind settles it and is ground truth", async () => {
      const overrides: unknown[] = [];
      const assessor = { assess: async () => assessed({ verdict: "ask", classification: { kind: "bug", confidence: 0.4, by: "model", at: iso(0), records: { assess: "rec-1" }, verdict: "ask" } }) };
      const { inbox, store } = setup({ assessor, hits: [hit({ ts: ts(10), text: "<@U1> hmm" })], truth: { override: async (i) => void overrides.push(i) } });
      await poll(inbox);
      const id = `C1:${ts(10)}`;
      expect(store.rows.get(id)!.conversation?.classification).toMatchObject({ verdict: "ask", kind: "bug" });
      const item = await inbox.patch(id, { kind: "question" }, TAP);
      expect(item.conversation?.classification).toMatchObject({ kind: "question", by: "person", verdict: "ok" });
      expect(item.triage?.category).toBe("question");
      expect(overrides).toMatchObject([{ thread: id, kind: "question" }]);
    });

    it("stores the relation and the shortlist the assessment offered", async () => {
      const shortlist = [{ slot: 1, id: "card-1", kind: "open" as const, otherSource: { kind: "jira" as const, key: "ENG-1" }, title: "t" }];
      const relation = { type: "related_to_in_progress" as const, target: "card-1", confidence: 0.9, by: "model" as const, at: iso(0), record: "rel-1", otherSource: { kind: "jira" as const, key: "ENG-1" } };
      const assessor = { assess: async () => assessed({ relation, shortlist }) };
      const { inbox, store } = setup({ assessor, hits: [hit({ ts: ts(10), text: "<@U1> it breaks" })] });
      await poll(inbox);
      const conversation = store.rows.get(`C1:${ts(10)}`)!.conversation!;
      expect(conversation.relation).toEqual(relation);
      expect(conversation.shortlist).toEqual(shortlist);
    });

    describe("a person sets the relation", () => {
      const shortlist = [{ slot: 2, id: "card-2", kind: "open" as const, otherSource: null, title: "t" }, { slot: 3, id: "backlog-3", kind: "backlog" as const, otherSource: null, title: "t" }];
      const ready = async () => {
        const labels: unknown[] = [];
        const assessor = { assess: async () => assessed({ relation: { type: "ask", target: null, confidence: 0.4, by: "model", at: iso(0), record: "rel-1" }, shortlist, classification: { kind: "bug", confidence: 0.9, by: "model", at: iso(0), records: { assess: "rec-1", relation: "rel-1" }, verdict: "ok" } }) };
        const world = setup({ assessor, hits: [hit({ ts: ts(10), text: "<@U1> it breaks" })], truth: { override: async () => {}, relation: async (i: unknown) => void labels.push(i) } });
        await poll(world.inbox);
        return { ...world, labels, id: `C1:${ts(10)}` };
      };
      it("with a target from the stored shortlist: by person, and the record learns it", async () => {
        const { inbox, labels, id } = await ready();
        const item = await inbox.relate(id, { relation: "related_to_backlog", target: "backlog-3" });
        expect(item.conversation?.relation).toMatchObject({ type: "related_to_backlog", target: "backlog-3", by: "person", record: "rel-1" });
        expect(labels).toMatchObject([{ thread: id, record: "rel-1", relation: "related_to_backlog", slot: 3 }]);
      });
      it("as new candidate or none without a target; the label says whether new work was asked", async () => {
        const { inbox, labels, id } = await ready();
        await inbox.relate(id, { relation: "new_candidate" });
        await inbox.relate(id, { relation: "none" });
        expect(labels).toMatchObject([{ relation: "new_candidate", slot: null }, { relation: "none", slot: null }]);
      });
      it("refuses a target that is not in the shortlist, a related type with no target, and a target on none", async () => {
        const { inbox, id } = await ready();
        await expect(inbox.relate(id, { relation: "related_to_in_progress", target: "card-9" })).rejects.toBeInstanceOf(BadRelationError);
        await expect(inbox.relate(id, { relation: "related_to_in_progress" })).rejects.toBeInstanceOf(BadRelationError);
        await expect(inbox.relate(id, { relation: "none", target: "card-2" })).rejects.toBeInstanceOf(BadRelationError);
      });
    });

    describe("the relation's action", () => {
      const card = { type: "related_to_in_progress" as const, target: "card-1", confidence: 0.9, by: "model" as const, at: iso(0) };
      const actions = () => {
        const log: string[] = [];
        return { log, apply: async (row: SlackItemRow, relation: ConversationRelation) => (log.push(`apply ${row.id} ${relation.type}`), { relation: { ...relation, applied: { at: iso(0), bumped: false } }, taskId: "card-1", priority: "P0" as const }), undo: async (_p: unknown, next: ConversationRelation) => void log.push(`undo ${next.type}`) };
      };
      it("runs once at a verdict that is not ask: the item links to the card and takes its priority; no card is made", async () => {
        const a = actions();
        const assessor = { assess: async () => assessed({ relation: card }) };
        const { inbox, store, created } = setup({ assessor, actions: a, hits: [hit({ ts: ts(10), text: "<@U1> it breaks" })] });
        await poll(inbox);
        await poll(inbox);
        const row = store.rows.get(`C1:${ts(10)}`)!;
        expect(a.log).toEqual([`apply C1:${ts(10)} related_to_in_progress`]);
        expect(row.linked.taskId).toBe("card-1");
        expect(row.triage?.priority).toBe("P0");
        expect(row.conversation?.relation?.applied).toBeDefined();
        expect(created).toEqual([]);
      });
      it("hands a first assessment's own classification to the action: a new candidate is added to the backlog on the first run", async () => {
        const added: unknown[] = [];
        const real = new ConversationActions({ attachThread: async () => ({}) as never, bump: async () => {}, unbump: async () => {}, addCandidate: async (input) => (added.push(input), { id: "b-1" }), linkedTo: async () => [] });
        const scores = { who: { score: 2, confidence: 0.9 }, what: { score: 2, confidence: 0.9 }, impact: { score: 1, confidence: 0.9 }, time: { score: 3, confidence: 0.9 }, demand: { score: 1, confidence: 0.9 } };
        const assessor = { assess: async () => assessed({ relation: { type: "new_candidate", target: null, confidence: 0.9, by: "model", at: iso(0) }, classification: { kind: "bug", confidence: 0.9, by: "model", at: iso(0), records: {}, verdict: "ok", scores } }) };
        const { inbox, store } = setup({ assessor, actions: real, claimed: { C1: "/r" }, hits: [hit({ ts: ts(10), text: "<@U1> it breaks" })] });
        await poll(inbox);
        await poll(inbox);
        expect(added).toHaveLength(1);
        expect(added[0]).toMatchObject({ repo: "/r", scores: { who: 2, what: 2, impact: 1, time: 3, demand: 1 } });
        expect(store.rows.get(`C1:${ts(10)}`)!.conversation?.relation?.applied).toMatchObject({ backlog: "b-1" });
      });
      it("does not run for ask, nor for a verdict ask", async () => {
        const a = actions();
        const assessor = { assess: async () => assessed({ relation: { ...card, type: "ask", target: null } }) };
        const { inbox, created } = setup({ assessor, actions: a, hits: [hit({ ts: ts(10), text: "<@U1> it breaks" })] });
        await poll(inbox);
        expect(a.log).toEqual([]);
        expect(created).toEqual([]);
      });
      it("runs when a person sets the relation, and takes back what the model's relation raised", async () => {
        const a = actions();
        const assessor = { assess: async () => assessed({ relation: card, shortlist: [{ slot: 1, id: "card-1", kind: "open", otherSource: null, title: "t" }, { slot: 2, id: "b-2", kind: "backlog", otherSource: null, title: "t" }] }) };
        const { inbox, created } = setup({ assessor, actions: a, hits: [hit({ ts: ts(10), text: "<@U1> it breaks" })] });
        await poll(inbox);
        await inbox.relate(`C1:${ts(10)}`, { relation: "related_to_backlog", target: "b-2" });
        expect(a.log).toEqual([`apply C1:${ts(10)} related_to_in_progress`, "undo related_to_backlog", `apply C1:${ts(10)} related_to_backlog`]);
        expect(created).toEqual([]);
      });
    });

    describe("the draft", () => {
      const relation = { type: "none" as const, target: null, confidence: 0.9, by: "model" as const, at: iso(0) };
      it("is stored in triage.draft after the relation, from the row as the chain left it, and nothing is posted", async () => {
        const seen: Array<ConversationRelation | null | undefined> = [];
        const drafter = { draft: async (row: SlackItemRow) => (seen.push(row.conversation?.relation), "It is queued.") };
        const { inbox, store, slack } = setup({ assessor: { assess: async () => assessed({ relation }) }, drafter, hits: [hit({ ts: ts(10), text: "<@U1> it breaks" })] });
        const post = vi.spyOn(slack, "postMessage");
        await poll(inbox);
        expect(store.rows.get(`C1:${ts(10)}`)!.triage?.draft).toBe("It is queued.");
        expect(seen).toEqual([relation]);
        expect(post).not.toHaveBeenCalled();
      });
      it("leaves no draft and retries when the run fails", async () => {
        const drafter = { draft: async () => { throw new Error("container failed"); } };
        const { inbox, store } = setup({ assessor: { assess: async () => assessed({ relation }) }, drafter, hits: [hit({ ts: ts(10), text: "<@U1> it breaks" })] });
        await poll(inbox);
        expect(store.rows.get(`C1:${ts(10)}`)!.triage).toBeNull();
      });
    });

    describe("drafts wait for a tap", () => {
      const relation = { type: "none" as const, target: null, confidence: 0.9, by: "model" as const, at: iso(0) };
      const clock = { ms: NOW.getTime() };
      const waiting = async (over: World = {}) => {
        clock.ms = NOW.getTime();
        const drafts = new ConversationDrafts(new MemoryDraftStore(), { expiryHours: () => 24, now: () => new Date(clock.ms) });
        const outcomes: unknown[] = [];
        const world = setup({ assessor: { assess: async () => assessed({ relation }) }, drafter: { draft: async () => "It is queued." }, drafts, now: () => new Date(clock.ms), truth: { override: async () => {}, outcome: async (i: unknown) => void outcomes.push(i) }, hits: [hit({ ts: ts(10), text: "<@U1> it breaks" })], ...over });
        const post = vi.spyOn(world.slack, "postMessage");
        await poll(world.inbox);
        return { ...world, drafts, outcomes, post, id: `C1:${ts(10)}` };
      };
      it("opens one waiting draft after the relation, mirrored in triage.draft and on the item, which sits in needs_reply", async () => {
        const { inbox, store, drafts, id, post } = await waiting();
        expect((await drafts.waiting(id))?.text).toBe("It is queued.");
        expect(store.rows.get(id)!.triage?.draft).toBe("It is queued.");
        const item = inbox.snapshot.items.find((i) => i.id === id)!;
        expect(item.draft).toMatchObject({ kind: "reply", text: "It is queued." });
        expect(item.split).toBe("needs_reply");
        expect(post).not.toHaveBeenCalled();
      });
      it("writes no draft and supersedes the waiting one when another person is already replying in the thread", async () => {
        const replies = { [`C1:${ts(10)}`]: [msg({ ts: ts(10), user: "U2", text: "it breaks" }), msg({ ts: ts(9.9), user: "U3", text: "looking" })] };
        const { drafts, id } = await waiting({ replies });
        expect(await drafts.waiting(id)).toBeNull();
      });
      it("says why in fixed words when the pack's draft is refused for an address", async () => {
        const { store, drafts, id } = await waiting({ drafter: { draft: async (_row: SlackItemRow, onRefused?: (why: string) => void) => (onRefused?.("the reply held an address, so it was not kept"), null) } });
        expect(await drafts.waiting(id)).toBeNull();
        expect(store.rows.get(id)!.triage?.why).toContain("the reply held an address, so it was not kept");
      });
      const proof = async (drafts: ConversationDrafts, id: string) => {
        const d = (await drafts.waiting(id))!;
        return { id: d.id, hash: draftHash(d.text) };
      };
      it("a draft sent as drafted is escaped once: its `<` is not turned into `&amp;lt;`, its `&` becomes `&amp;`", async () => {
        const w = await waiting({ drafter: { draft: async () => postable("a < b & c > d") } });
        expect((await w.drafts.waiting(w.id))?.text).toBe("a &lt; b & c &gt; d");
        await w.inbox.reply(w.id, "a &lt; b & c &gt; d", TAP, false, await proof(w.drafts, w.id));
        expect(w.post).toHaveBeenLastCalledWith("C1", "a &lt; b &amp; c &gt; d", expect.anything());
      });
      describe("the card's own PR address", () => {
        const PR = "https://github.com/acme/app/pull/42";
        const card = { type: "related_to_in_progress" as const, target: "card-1", confidence: 0.9, by: "model" as const, at: iso(0) };
        const shortlist = [{ slot: 1, id: "card-1", kind: "open" as const, otherSource: null, title: "t" }];
        const withCard = (text: string, cardAddress: World["cardAddress"] = async () => PR) =>
          waiting({ assessor: { assess: async () => assessed({ relation: card, shortlist }) }, drafter: { draft: async () => postableKeeping(text, [PR]) }, cardAddress });
        it("sends an unchanged draft that holds it, whole", async () => {
          const w = await withCard(`Fix: ${PR}`);
          expect((await w.drafts.waiting(w.id))?.text).toBe(`Fix: ${PR}`);
          await w.inbox.reply(w.id, `Fix: ${PR}`, TAP, false, await proof(w.drafts, w.id));
          expect(w.post).toHaveBeenCalledTimes(1);
          expect(w.post.mock.calls[0]![1]).toContain(PR);
        });
        it("refuses a stored draft that holds another address, even beside the card's", async () => {
          const w = await withCard(`Fix: ${PR}`);
          const d = (await w.drafts.waiting(w.id))!;
          const other = `Fix: ${PR} and https://evil.example/x`;
          await w.drafts.open({ thread: w.id, channel: "C1", threadTs: ts(10), kind: "reply", text: other, cardId: d.cardId, private: false, records: {} });
          await expect(w.inbox.reply(w.id, other, TAP, false, await proof(w.drafts, w.id))).rejects.toBeInstanceOf(SlackRefusedError);
          expect(w.post).not.toHaveBeenCalled();
        });
        it("refuses a draft with the card's address when the machine cannot read that address", async () => {
          const w = await withCard(`Fix: ${PR}`, async () => null);
          await expect(w.inbox.reply(w.id, `Fix: ${PR}`, TAP, false, await proof(w.drafts, w.id))).rejects.toBeInstanceOf(SlackRefusedError);
          expect(w.post).not.toHaveBeenCalled();
        });
      });
      it("a reply with the id and hash of another draft posts the person's text and settles and labels nothing", async () => {
        const w = await waiting();
        const d = (await w.drafts.waiting(w.id))!;
        await w.inbox.reply(w.id, "We are on it.", TAP, false, { id: d.id, hash: "0".repeat(64) });
        expect(w.post).toHaveBeenCalledTimes(1);
        expect(w.outcomes).toEqual([]);
        expect((await w.drafts.waiting(w.id))?.id).toBe(d.id);
      });
      it("a reply from a board that sends neither id nor hash still posts, and settles no draft", async () => {
        const w = await waiting();
        await w.inbox.reply(w.id, "It is queued.", TAP);
        expect(w.post).toHaveBeenCalledTimes(1);
        expect(w.outcomes).toEqual([]);
        expect(await w.drafts.waiting(w.id)).not.toBeNull();
      });
      it("a reply with the draft's own text settles it as sent, another text as edited, and each is ground truth", async () => {
        const first = await waiting();
        await first.inbox.reply(first.id, "It is queued.", TAP, false, await proof(first.drafts, first.id));
        expect(first.post).toHaveBeenCalledTimes(1);
        expect((await first.drafts.get((first.outcomes[0] as { draft: string }).draft))?.status).toBe("sent");
        expect(first.outcomes).toMatchObject([{ thread: first.id, outcome: "sent_as_drafted" }]);
        const second = await waiting();
        await second.inbox.reply(second.id, "We are on it.", TAP, false, await proof(second.drafts, second.id));
        expect(second.outcomes).toMatchObject([{ outcome: "edited", machine: "It is queued.", person: "We are on it." }]);
        expect(second.store.rows.get(second.id)!.triage?.draft ?? null).toBeNull();
      });
      it("tells the truth writer whether the thread is private: a public channel is not, a private one is", async () => {
        const open = await waiting();
        await open.inbox.reply(open.id, "We are on it.", TAP, false, await proof(open.drafts, open.id));
        expect(open.outcomes).toMatchObject([{ outcome: "edited", private: false }]);
        const dm = await waiting();
        const row = dm.store.rows.get(dm.id)!;
        dm.store.rows.set(dm.id, { ...row, conversation: { ...row.conversation!, private: true } });
        await dm.inbox.reply(dm.id, "We are on it.", TAP, false, await proof(dm.drafts, dm.id));
        expect(dm.outcomes).toMatchObject([{ outcome: "edited", private: true }]);
      });
      it("refuses a reply that carries a token, with no post and the draft still waiting", async () => {
        const { inbox, drafts, id, post } = await waiting();
        const token = ["gh", "p_", "a".repeat(36)].join("");
        await expect(inbox.reply(id, `use ${token}`, TAP)).rejects.toBeInstanceOf(SlackRefusedError);
        expect(post).not.toHaveBeenCalled();
        expect(await drafts.waiting(id)).not.toBeNull();
      });
      it("passes the reason a person gave for dismissing a draft to the outcome, and none when none was given", async () => {
        const a = await waiting();
        await a.inbox.patch(a.id, { done: true, reason: "no_reply_needed" }, TAP);
        expect(a.outcomes).toMatchObject([{ outcome: "ignored", reason: "no_reply_needed" }]);
        const b = await waiting();
        await b.inbox.patch(b.id, { done: true }, TAP);
        expect((b.outcomes as Array<Record<string, unknown>>)[0]).not.toHaveProperty("reason");
      });
      it("marks the waiting draft ignored on done, and expires it after the configured hours without posting", async () => {
        const a = await waiting();
        await a.inbox.patch(a.id, { done: true }, TAP);
        expect((await a.drafts.waiting(a.id))).toBeNull();
        expect(a.outcomes).toMatchObject([{ outcome: "ignored" }]);
        const b = await waiting();
        clock.ms += 25 * 3_600_000;
        await b.inbox.expireDrafts();
        expect(b.outcomes).toMatchObject([{ outcome: "expired" }]);
        expect(b.store.rows.get(b.id)!.triage?.draft ?? null).toBeNull();
        expect(b.post).not.toHaveBeenCalled();
      });
    });

    describe("a card from a conversation, made only by a tap", () => {
      it("is built from candidateOf with the hints and the machine of origin: kind, the priority as urgency, the confidence", async () => {
        const assessor = { assess: async () => assessed({ classification: { kind: "bug", confidence: 0.85, by: "model", at: iso(0), records: {}, verdict: "ok", priority: "P1" } }) };
        const { inbox, created } = setup({ assessor, hits: [hit({ ts: ts(10), text: "<@U1> login fails\nsecond line" })], claimed: { C1: "/r" } });
        await poll(inbox);
        await inbox.toTask(`C1:${ts(10)}`, {}, TAP);
        expect(created).toHaveLength(1);
        expect(created[0]).toMatchObject({ title: "@higor login fails", originMachine: "conversation", hints: { kind: "bug", urgency: "P1", confidence: 0.85 }, reporter: { id: "U2", channel: "slack" }, source: { kind: "slack", channel: "C1" } });
        expect((created[0] as { description: string }).description).toContain("> marta: ");
      });
      it("carries no thread text when the conversation is private", async () => {
        const assessor = { assess: async () => assessed() };
        const { inbox, store, created } = setup({ assessor, hits: [hit({ ts: ts(10), text: "<@U1> the plan is banana", channel: { id: "G1", name: "secret" } })] });
        await poll(inbox);
        const id = `G1:${ts(10)}`;
        expect(store.rows.get(id)?.conversation?.private).toBe(true);
        await inbox.toTask(id, {}, TAP);
        expect(created).toHaveLength(1);
        expect(JSON.stringify(created[0])).not.toContain("banana");
        expect(created[0]).toMatchObject({ title: "A private Slack conversation" });
      });
    });

    it("retries a failed call on the retry clock and leaves triage null meanwhile", async () => {
      const assessor = { assess: async () => { throw new Error("container failed"); } };
      const { inbox, store } = setup({ assessor, hits: [hit({ ts: ts(10), text: "<@U1> it breaks" })] });
      await poll(inbox);
      expect(store.rows.get(`C1:${ts(10)}`)!.triage).toBeNull();
    });
  });

  it("runs the rules first: own messages dropped, muted channels never stored, bots settled without the model, VIPs floored", async () => {
    const rules = `## VIPs\n- @ana\n\n## Muted channels\n- #random\n\n## Always P0 keywords\n- rollback\n`;
    const { inbox, triaged, store } = setup({
      rules,
      hits: [
        hit({ ts: ts(9), user: "U1", text: "<@U1> note to self" }),
        hit({ ts: ts(8), channel: { id: "CR", name: "random" }, text: "<@U1> lol" }),
        hit({ ts: ts(7), user: "U3", text: "<@U1> thoughts?" }),
        hit({ ts: ts(6), text: "<@U1> we need a rollback" }),
      ],
      history: { C1: [msg({ ts: ts(5), user: "UB", text: "<!here> deploy done" })] },
      answer: (item) => ({ ...answerAll(item), priority: "P3" }),
    });
    const { items } = await poll(inbox);
    expect(items.map((i) => [i.author.name, i.triage?.priority, i.triage?.by, i.triage?.category])).toEqual([
      ["deploybot", "P3", "rules", "automated"],
      ["marta", "P0", "model", "question"],
      ["ana", "P1", "model", "question"],
    ]);
    expect(triaged[0]!.map((t) => t.author)).toEqual(["@ana", "@marta"]);
    expect(store.rows.has(`CR:${ts(8)}`)).toBe(false);
  });

  it("sweeps DMs and channels: DMs are items, broadcasts and watched keywords are watch items, the rest is ignored", async () => {
    const { inbox, store } = setup({
      history: {
        D1: [msg({ ts: ts(20), text: "standup at 10?" }), msg({ ts: ts(19), user: "U1", text: "sure" }), msg({ ts: ts(18), subtype: "channel_join", text: "joined" })],
        C9: [msg({ ts: ts(15), text: "<!channel> checkout is down" }), msg({ ts: ts(14), text: "the luna board is nice" }), msg({ ts: ts(13), text: "nothing for you" })],
      },
    });
    await store.addWatch({ kind: "keyword", value: "luna", label: "luna", channels: ["C9"], priority: "P2" });
    await store.addWatch({ kind: "keyword", value: "nothing", label: "nothing", channels: ["C1"], priority: null });
    const { items } = await poll(inbox);
    // Newest first.
    expect(items.map((i) => [i.kind, i.channel.name, i.matched, i.triage?.priority])).toEqual([
      ["watch", "payments-oncall", ["keyword:luna"], "P1"],
      ["watch", "payments-oncall", ["broadcast:channel"], "P1"],
      ["dm", "marta", ["dm"], "P1"],
    ]);
    expect(items[2]!.split).toBe("needs_reply");
    expect(items[2]!.permalink).toBe(`https://x.slack.com/archives/D1/p${ts(20).replace(".", "")}`);
  });

  it("collapses several mentions in one thread into one item and tracks its replies", async () => {
    const root = ts(60);
    const world: World = {
      hits: [
        hit({ ts: root, text: "<@U1> first ask?" }),
        hit({ ts: ts(50), text: "<@U1> second ask", permalink: `https://x.slack.com/archives/C1/p1?thread_ts=${root}&cid=C1` }),
      ],
      replies: { [`C1:${root}`]: [msg({ ts: ts(55), user: "U3", text: "I think so" }), msg({ ts: ts(50), text: "<@U1> second ask" })] },
    };
    const { inbox, store } = setup(world);
    let { items } = await poll(inbox);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: `C1:${root}`, count: 2, text: "@higor second ask", replies: 2, youReplied: false, threadTs: null });
    expect(items[0]!.context.map((m) => m.text)).toEqual(["I think so"]);

    // You answer in Slack itself: youReplied, no re-triage; then someone replies again: reopened ask.
    world.replies![`C1:${root}`]!.push(msg({ ts: ts(40), user: "U1", text: "done" }));
    ({ items } = await poll(inbox));
    expect(items[0]).toMatchObject({ replies: 3, youReplied: true, split: "fyi" });
    await inbox.patch(items[0]!.id, { done: true }, TAP);
    world.replies![`C1:${root}`]!.push(msg({ ts: ts(30), user: "U3", text: "<@U1> one more?" }));
    ({ items } = await poll(inbox));
    expect(items[0]).toMatchObject({ replies: 4, youReplied: false, doneAt: null, reopenedAt: NOW.toISOString(), count: 3, text: "@higor one more?", split: "needs_reply" });
    expect(store.rows.size).toBe(1);
  });

  it("reports an error, keeps the items, and backs off on a rate limit", async () => {
    const { inbox, published } = setup({ hits: [hit({ ts: ts(1) })] });
    await poll(inbox);
    const world = { searchError: "Slack rate limit on search.messages: retry after 30s" };
    const limited = setup(world);
    const snapshot = await poll(limited.inbox);
    expect(snapshot.error).toMatch(/rate limit/);
    expect(limited.inbox.nextDelayMs).toBe(5 * 60_000);
    expect(inbox.nextDelayMs).toBe(60_000);
    expect(published[0]!.items).toHaveLength(1);
  });

  it("creates the rules file from the template when it is missing, and runs without a triager", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { inbox, files } = setup({ rules: null, triager: null, hits: [hit({ ts: ts(2) })] });
      const { items } = await poll(inbox);
      expect(files.get("/rules.md")).toBe(RULES_TEMPLATE);
      expect(log).toHaveBeenCalledWith(expect.stringContaining("wrote the default rules file to /rules.md"));
      expect(items[0]!.triage).toBeNull();
      expect(items[0]!.split).toBe("fyi");
      await poll(inbox);
      expect(warn.mock.calls.filter((c) => String(c[0]).includes("without triage"))).toHaveLength(1);
    } finally {
      warn.mockRestore();
      log.mockRestore();
    }
  });

  it("runs one triage at a time: a poll while the pack runs queues its items for the next run, and a verdict lands on the row as it is now", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const batches: string[][] = [];
    const triager: Triager = {
      triage: async (items) => {
        batches.push(items.map((i) => i.id));
        if (batches.length === 1) await gate;
        return new Map(items.map((i) => [i.id, answerAll(i)]));
      },
    };
    const world: World = { triager, hits: [hit({ ts: ts(10), text: "<@U1> first?" })] };
    const { inbox, published, store } = setup(world);
    await inbox.pollOnce();
    await new Promise((r) => setTimeout(r, 0));
    expect(batches).toEqual([[`C1:${ts(10)}`]]);
    // A second poll while the container runs: persisted and published at once, triage queued.
    world.hits = [hit({ ts: ts(5), text: "<@U1> second?" })];
    await inbox.pollOnce();
    expect(inbox.snapshot.items.map((i) => i.triage)).toEqual([null, null]);
    expect(batches).toHaveLength(1);
    // You set a priority by hand meanwhile; the verdict keeps it.
    await inbox.patch(`C1:${ts(10)}`, { priority: "P0" }, TAP);
    release();
    await inbox.idle();
    expect(batches).toEqual([[`C1:${ts(10)}`], [`C1:${ts(5)}`]]);
    expect((await store.item(`C1:${ts(10)}`))!.triage).toMatchObject({ priority: "P0", overridden: true, by: "model", draft: "On it." });
    expect((await store.item(`C1:${ts(5)}`))!.triage).toMatchObject({ priority: "P1", by: "model" });
    expect(published.at(-1)!.items.every((i) => i.triage !== null)).toBe(true);
  });

  it("sums the pack's runs for the Floor", async () => {
    const { inbox, store } = setup();
    const run = { endedAt: iso(0), items: 4, model: "claude-haiku-5-5", turns: 1, costUsd: 0.01, ok: true, error: null };
    await store.recordTriageRun({ ...run, startedAt: iso(60) });
    await store.recordTriageRun({ ...run, startedAt: iso(30), items: 2, costUsd: 0.0052 });
    await store.recordTriageRun({ ...run, startedAt: iso(10 * 24 * 60), items: 9 });
    const since = new Date(NOW.getTime() - 7 * 86_400_000);
    const summary = await inbox.triageRuns(since);
    expect(summary).toMatchObject({ since: since.toISOString(), items: 6, costUsd: 0.0152 });
    expect(summary.runs.map((r) => r.startedAt)).toEqual([iso(30), iso(60)]);
  });

  it("dues each open ask under the rules file's SLA and says which SLA is in effect; off is 0 on the wire", async () => {
    const { inbox } = setup({ hits: [hit({ ts: ts(45), text: "<@U1> approve?" }), hit({ ts: ts(5), text: "<@U1> fyi only" })] });
    const { items, sla } = await poll(inbox);
    // P1 at 30m: the 45-minute-old ask was due 15 minutes ago; the FYI expects nothing.
    expect(items.map((i) => [i.dueAt, i.overdue])).toEqual([
      [null, false],
      [iso(15), true],
    ]);
    expect(sla).toEqual({ P0: 600, P1: 1800, P2: 3600, P3: 3600 });
    const relaxed = setup({ rules: "## SLA\n- P1: 2h\n- P2: off\n", hits: [hit({ ts: ts(45), text: "<@U1> approve?" })] });
    const snapshot = await poll(relaxed.inbox);
    expect(snapshot.items[0]).toMatchObject({ dueAt: iso(-75), overdue: false });
    expect(snapshot.sla).toEqual({ P0: 600, P1: 7200, P2: 0, P3: 3600 });
  });

  it("the minute tick turns an ask overdue with no Slack event, publishing only when something flipped", async () => {
    const clock = { now: NOW };
    const { inbox, published } = setup({ hits: [hit({ ts: ts(20), text: "<@U1> approve?" })], now: () => clock.now });
    await poll(inbox);
    expect(inbox.snapshot.items[0]).toMatchObject({ dueAt: iso(-10), overdue: false });
    const before = published.length;
    clock.now = new Date(NOW.getTime() + 5 * 60_000);
    inbox.tick();
    expect(published).toHaveLength(before);
    clock.now = new Date(NOW.getTime() + 11 * 60_000);
    inbox.tick();
    expect(published).toHaveLength(before + 1);
    expect(published.at(-1)!.items[0]).toMatchObject({ dueAt: iso(-10), overdue: true });
  });

  it("start() runs the tick every minute, between polls", async () => {
    vi.useFakeTimers({ now: NOW });
    const clock = { now: NOW };
    const { inbox, slack } = setup({ hits: [hit({ ts: ts(29), text: "<@U1> approve?" })], now: () => clock.now, intervalMs: 10 * 60_000 });
    try {
      inbox.start();
      await vi.advanceTimersByTimeAsync(0);
      await inbox.idle();
      expect(inbox.snapshot.items[0]!.overdue).toBe(false);
      const polls = slack.searchMentions.mock.calls.length;
      clock.now = new Date(NOW.getTime() + 2 * 60_000);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(inbox.snapshot.items[0]!.overdue).toBe(true);
      expect(slack.searchMentions.mock.calls.length).toBe(polls);
    } finally {
      inbox.stop();
      vi.useRealTimers();
    }
  });

  it("gives an item the model skipped a rules fallback", async () => {
    const { inbox } = setup({ hits: [hit({ ts: ts(2), text: "<@U1> fyi" })], answer: () => null });
    const { items } = await poll(inbox);
    expect(items[0]!.triage).toMatchObject({ priority: "P2", category: "fyi", by: "rules", summary: "@higor fyi" });
  });
});

describe("SlackInbox actions", () => {
  async function seeded(world: World = {}) {
    const w = setup({ hits: [hit({ ts: ts(30), text: "<@U1> can you approve?" })], ...world });
    const { items } = await poll(w.inbox);
    return { ...w, item: items[0]! };
  }

  it("patch: done clears (marking Slack only when told), learns a lowered prior, reopens, snoozes, overrides priority", async () => {
    const { inbox, item, slack, files } = await seeded();
    let patched = await inbox.patch(item.id, { done: true }, TAP);
    expect(patched).toMatchObject({ doneAt: NOW.toISOString(), split: "done" });
    expect(slack.mark).not.toHaveBeenCalled();
    expect(files.get("/rules.learned.md")).toContain("- U2 (@marta): lowered (1)");
    expect(files.get("/rules.md")).toBe(RULES_TEMPLATE);
    patched = await inbox.patch(item.id, { done: false }, TAP);
    expect(patched).toMatchObject({ doneAt: null, split: "needs_reply" });
    patched = await inbox.patch(item.id, { snoozedUntil: iso(-60), seen: true }, TAP);
    expect(patched).toMatchObject({ split: "snoozed", seenAt: NOW.toISOString() });
    patched = await inbox.patch(item.id, { snoozedUntil: null, priority: "P0" }, TAP);
    expect(patched.triage).toMatchObject({ priority: "P0", overridden: true });
    expect(patched.split).toBe("needs_reply");
    // A re-triage keeps the override.
    await poll(inbox);
    expect(inbox.snapshot.items[0]!.triage).toMatchObject({ priority: "P0", overridden: true });
    await expect(inbox.patch("C1:nope", { done: true }, TAP)).rejects.toThrow(NoItemError);

    const marking = await seeded({ markRead: true });
    await marking.inbox.patch(marking.item.id, { done: true }, TAP);
    expect(marking.slack.mark).toHaveBeenCalledWith("C1", ts(30));
  });

  it("reply posts in the thread as you, clears the item and learns a raised prior for a quick answer", async () => {
    const { inbox, item, slack, files, published } = await seeded();
    const before = published.length;
    const replied = await inbox.reply(item.id, "Approved.", TAP);
    expect(slack.postMessage).toHaveBeenCalledWith("C1", "Approved.", ts(30));
    expect(replied).toMatchObject({ doneAt: NOW.toISOString(), youReplied: true, split: "done" });
    expect(files.get("/rules.learned.md")).toContain("- U2 (@marta): raised (1)");
    expect(published.length).toBe(before + 1);
    const metrics = await inbox.metrics(new Date(NOW.getTime() - 86_400_000));
    expect(metrics).toMatchObject({ items: { P0: 0, P1: 1, P2: 0, P3: 0 }, replied: { P1: 1 }, withinHour: 1, withinSla: { P0: 0, P1: 1, P2: 0, P3: 0 }, sla: { P1: 1800 }, timeToReply: { P1: { median: 1800, p90: 1800 } } });
    expect(metrics.byDay).toEqual([{ day: "2026-10-28", items: 1, replied: 1 }]);
  });

  it("metrics count the replies inside each priority's SLA, skipping a priority whose SLA is off", async () => {
    const { inbox, store, item } = await seeded({ rules: "## SLA\n- P3: off\n" });
    const base = (await store.item(item.id))!;
    const replied = (id: string, priority: "P0" | "P1" | "P2" | "P3", minutes: number) => ({ ...base, id, ts: iso(minutes), repliedAt: iso(0), doneAt: iso(0), youReplied: true, triage: { ...base.triage!, priority, expectsReply: true } });
    // P0 at 10m: 30 minutes is late; P2 at 1h: 30 minutes is fine; P3 off: not counted at all.
    await store.save([replied("C1:a", "P0", 30), replied("C1:b", "P2", 30), replied("C1:c", "P3", 1), replied("C1:d", "P1", 30)]);
    const metrics = await inbox.metrics(new Date(NOW.getTime() - 86_400_000));
    expect(metrics.replied).toEqual({ P0: 1, P1: 1, P2: 1, P3: 1 });
    expect(metrics.withinSla).toEqual({ P0: 0, P1: 1, P2: 1, P3: 0 });
    expect(metrics.sla).toEqual({ P0: 600, P1: 1800, P2: 3600, P3: 0 });
  });

  it("reply in a thread uses the parent ts, and without a token fails with NoSlackTokenError", async () => {
    const root = ts(90);
    const { inbox, item, store, slack } = await seeded({ hits: [hit({ ts: ts(30), text: "<@U1> ok?", permalink: `https://x.slack.com/p?thread_ts=${root}&cid=C1` })] });
    expect(item.threadTs).toBe(root);
    expect(item.id).toBe(`C1:${root}`);
    await inbox.reply(item.id, "yes", TAP);
    expect(slack.postMessage).toHaveBeenCalledWith("C1", "yes", root);
    const silent = new SlackInbox({ slack: noTokenSlack(), triager: null, store, intervalMs: 1, publish: () => {}, findTask: async () => null, linkPr: () => null, createTask: async () => ({}) as TaskRow, markRead: false, rulesPath: "/r", socketToken: null, now: () => NOW, files: { read: async () => "", write: async () => {} } });
    await expect(silent.reply(item.id, "x", TAP)).rejects.toThrow(NoSlackTokenError);
    const snapshot = await poll(silent);
    expect(snapshot.error).toMatch(/MACHINE_SLACK_USER_TOKEN/);
  });

  it("toTask creates a Backlog task from the item and links it once", async () => {
    const { inbox, item, created } = await seeded();
    const task = await inbox.toTask(item.id, { repoPath: "/r/a" }, TAP);
    expect(created[0]).toEqual({
      title: "re: @higor can you appro",
      reporter: { id: "U2", name: "marta", channel: "slack" },
      description: `From Slack: @marta in #eng · ${item.permalink}\n\n> @marta: @higor can you approve?`,
      repoPath: "/r/a",
      source: { kind: "slack", channel: "C1", ts: ts(30), permalink: item.permalink },
    });
    expect(inbox.snapshot.items[0]!.linked.taskId).toBe(task.id);
    await expect(inbox.toTask(item.id, {}, TAP)).rejects.toThrow(AlreadyTaskError);
    const titled = await seeded();
    await titled.inbox.toTask(titled.item.id, { title: "Approve the thing" }, TAP);
    expect(titled.created[0]).toMatchObject({ title: "Approve the thing", repoPath: null });
  });

  it("toTask on a row stored before this wave: a DM's text never enters the card, a public channel's personal data is masked", async () => {
    const dm = await seeded();
    const stored = (await dm.store.item(dm.item.id))!;
    const legacy = { ...stored, channel: { id: "D9", name: "marta", kind: "dm" as const }, text: "my password is hunter2, call +1 415-555-0132", context: [], conversation: undefined };
    await dm.store.save([legacy as never]);
    await dm.inbox.toTask(dm.item.id, {}, TAP);
    const card = JSON.stringify(dm.created[0]);
    expect(card).not.toMatch(/hunter2|415-555|password/);
    const open = await seeded();
    const row = (await open.store.item(open.item.id))!;
    await open.store.save([{ ...row, text: "mail ana@example.com or call +1 415-555-0132", context: [], conversation: undefined } as never]);
    await open.inbox.toTask(open.item.id, {}, TAP);
    const made = open.created[0] as { title: string; description: string };
    expect(`${made.title}\n${made.description}`).not.toMatch(/ana@example|415-555/);
    expect(made.description).toContain("[email]");
  });

  it("watches: add with a resolved label, patch, delete, builtins stay", async () => {
    const { inbox, published } = await seeded();
    const group = await inbox.addWatch({ kind: "usergroup", value: "S1", channels: [], priority: "P1" });
    expect(group).toMatchObject({ label: "@platform-team", priority: "P1", enabled: true, builtin: false });
    const channel = await inbox.addWatch({ kind: "channel", value: "C9", channels: [], priority: null });
    expect(channel.label).toBe("#payments-oncall");
    const word = await inbox.addWatch({ kind: "keyword", value: "luna", label: "Luna", channels: ["C1"], priority: null });
    expect(word.label).toBe("Luna");
    expect(await inbox.patchWatch(word.id, { enabled: false })).toMatchObject({ enabled: false });
    await inbox.deleteWatch(word.id);
    const all = await inbox.watches();
    expect(all.map((w) => w.label)).toEqual(["@here", "@channel", "@everyone", "@platform-team", "#payments-oncall"]);
    await expect(inbox.deleteWatch(all[0]!.id)).rejects.toThrow(BuiltinWatchError);
    expect(published.at(-1)!.watches).toHaveLength(5);
    expect(await inbox.usergroups()).toEqual([{ id: "S1", handle: "platform-team", name: "Platform" }]);
    expect((await inbox.channels()).map((c) => c.id)).toEqual(["C1", "C9", "CR"]);
  });

  it("digest lists open P0/P1, what waits on them and yesterday's numbers, and posts to your DM", async () => {
    const { inbox, slack, store } = await seeded({ answer: (item) => ({ ...answerAll(item), priority: "P0", category: "blocker" }) });
    const waiting = { ...(await store.item(inbox.snapshot.items[0]!.id))!, id: "C9:1", channel: { id: "C9", name: "payments-oncall", kind: "channel" as const }, youReplied: true, ts: iso(26 * 60), triage: null };
    await store.save([waiting]);
    const text = await inbox.digest();
    expect(text.split("\n")).toEqual([
      "Slack inbox · 2026-10-28",
      "1 overdue now",
      "Needs reply: 1 (1 at P0/P1)",
      "- P0 #eng @marta: re: @higor can you appro",
      "Waiting on them: 1",
      "- P? #payments-oncall @marta: @higor can you approve?",
      "Last 24h: 1 item(s), 0 answered within the hour",
    ]);
    await inbox.postDigest();
    expect(slack.openDm).toHaveBeenCalledWith("U1");
    expect(slack.postMessage).toHaveBeenCalledWith("D1", text);
    // Nothing overdue: no such line.
    const calm = await seeded({ rules: "## SLA\n- P1: 2h\n" });
    expect((await calm.inbox.digest()).split("\n")[1]).toBe("Needs reply: 1 (1 at P0/P1)");
  });

  it("socket events flag channels for the next poll and queue reactions to your messages", async () => {
    const { inbox, slack } = await seeded({ history: { C9: [msg({ ts: ts(1), text: "<@U1> via socket" })] } });
    slack.history.mockClear();
    inbox.handleSocketEvent({ type: "message", channel: "C9", ts: ts(1), user: "U2", text: "<@U1> via socket" });
    inbox.handleSocketEvent({ type: "message", subtype: "message_changed", ts: ts(0), message: { ts: ts(1), text: "edited" }, previous_message: { channel: "CR", ts: ts(1) } });
    inbox.handleSocketEvent({ type: "message", subtype: "message_deleted", ts: ts(0), deleted_ts: ts(2) });
    inbox.handleSocketEvent({ type: "reaction_added", user: "U3", reaction: "eyes", item_user: "U1", item: { type: "message", channel: "C1", ts: ts(5) }, event_ts: ts(0) });
    inbox.handleSocketEvent({ type: "reaction_added", user: "U3", reaction: "eyes", item_user: "U2", item: { type: "message", channel: "C1", ts: ts(4) }, event_ts: ts(0) });
    inbox.stop();
    const { items } = await poll(inbox);
    expect(slack.history).toHaveBeenCalledWith("C9", expect.any(String), 100);
    expect(slack.history).toHaveBeenCalledWith("CR", expect.any(String), 100);
    expect(slack.history).not.toHaveBeenCalledWith("C1", expect.any(String), 100);
    expect(items.map((i) => [i.kind, i.text])).toEqual(expect.arrayContaining([["mention", "@higor via socket"], ["reaction", ":eyes: on your message from @ana"]]));
    expect(items).toHaveLength(3);
  });

  it("reply escapes what you typed and a nudge mentions the author by id, unescaped", async () => {
    const { inbox, item, slack, triaged } = await seeded();
    await inbox.reply(item.id, "a < b & c > d", TAP);
    expect(slack.postMessage).toHaveBeenLastCalledWith("C1", "a &lt; b &amp; c &gt; d", ts(30));
    await inbox.reply(item.id, "any news?", TAP, true);
    expect(slack.postMessage).toHaveBeenLastCalledWith("C1", "<@U2> any news?", ts(30));
    // The learned prior reaches the model by name, not id.
    await poll(inbox);
    const more = await seeded({ hits: [hit({ ts: ts(3), text: "<@U1> next?" })] });
    await more.inbox.patch(more.item.id, { done: true }, TAP);
    const again = setup({ hits: [hit({ ts: ts(2), text: "<@U1> and again?" })] });
    again.files.set("/rules.learned.md", more.files.get("/rules.learned.md")!);
    await poll(again.inbox);
    expect(triaged.length).toBeGreaterThan(0);
    expect(again.triaged.length).toBe(1);
  });

  it("reply threads under the item's root ts, not the latest folded message; a top-level DM gets no thread", async () => {
    const root = ts(60);
    const { inbox, slack, store } = await seeded({
      hits: [hit({ ts: root, text: "<@U1> first ask?" }), hit({ ts: ts(50), text: "<@U1> second ask", permalink: `https://x.slack.com/archives/C1/p1?thread_ts=${root}&cid=C1` })],
      history: { D1: [msg({ ts: ts(20), text: "standup at 10?" })] },
    });
    const thread = (await store.item(`C1:${root}`))!;
    expect(thread.slackTs).toBe(ts(50));
    await inbox.reply(thread.id, "yes", TAP);
    expect(slack.postMessage).toHaveBeenLastCalledWith("C1", "yes", root);
    await inbox.reply(`D1:${ts(20)}`, "10 works", TAP);
    expect(slack.postMessage).toHaveBeenLastCalledWith("D1", "10 works", undefined);
  });

  it("a reaction on the root of a thread you are in is its own item, not the thread's text", async () => {
    const root = ts(5);
    const { inbox, store } = await seeded({ hits: [hit({ ts: root, text: "<@U1> ship it?" })] });
    inbox.handleSocketEvent({ type: "reaction_added", user: "U3", reaction: "eyes", item_user: "U1", item: { type: "message", channel: "C1", ts: root }, event_ts: ts(0) });
    inbox.stop();
    const { items } = await poll(inbox);
    expect(items.map((i) => [i.id, i.kind, i.text]).sort()).toEqual([
      [`C1:${root}`, "mention", "@higor ship it?"],
      [`C1:${root}:reaction`, "reaction", ":eyes: on your message from @ana"],
    ]);
    expect((await store.item(`C1:${root}`))!.matched).toEqual(["me"]);
  });
});

describe("SlackInbox quiet hours", () => {
  it("the snapshot says when now is inside the quiet window, and the minute tick notices the edge", async () => {
    const clock = { now: new Date("2026-10-28T23:30:00") };
    const { inbox, published } = setup({ rules: "## Quiet hours\n22:00-08:00\n", hits: [hit({ ts: ts(5), text: "<@U1> hi?" })], now: () => clock.now });
    const snapshot = await poll(inbox);
    expect(snapshot.quiet).toBe(true);
    clock.now = new Date("2026-10-29T08:00:00");
    inbox.tick();
    expect(inbox.snapshot.quiet).toBe(false);
    expect(published.at(-1)!.quiet).toBe(false);
    const open = setup({ hits: [hit({ ts: ts(5), text: "<@U1> hi?" })] });
    expect((await poll(open.inbox)).quiet).toBe(false);
  });
});

describe("SlackInbox resilience", () => {
  it("a poll that fails midway moves no cursor: the next poll re-finds the same messages", async () => {
    const world: World = { hits: [hit({ ts: ts(10), text: "<@U1> hi?" })] };
    const { inbox, slack, store } = setup(world);
    slack.history.mockRejectedValueOnce(new Error("internal_error"));
    const failed = await inbox.pollOnce();
    expect(failed.error).toBe("internal_error");
    expect(store.rows.size).toBe(0);
    await poll(inbox);
    const searches = slack.searchMentions.mock.calls;
    expect(searches).toHaveLength(2);
    expect(searches[1]![1]).toBe(searches[0]![1]);
    expect(inbox.snapshot.items).toHaveLength(1);
    await poll(inbox);
    expect(slack.searchMentions.mock.calls[2]![1]).toBe(ts(10));
  });

  it("an action during a long poll survives it: the poll merges only what it owns", async () => {
    const root = ts(30);
    const world: World = { hits: [hit({ ts: root, text: "<@U1> approve?" })] };
    const { inbox, slack, store } = setup(world);
    await poll(inbox);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    world.replies = { [`C1:${root}`]: [msg({ ts: ts(20), user: "U3", text: "bump" })] };
    slack.replies.mockImplementationOnce(async (channel, threadTs) => {
      await gate;
      return world.replies![`${channel}:${threadTs}`] ?? [];
    });
    const polling = inbox.pollOnce();
    await new Promise((r) => setTimeout(r, 0));
    await inbox.patch(`C1:${root}`, { done: true, priority: "P0" }, TAP);
    release();
    await polling;
    await inbox.idle();
    const row = (await store.item(`C1:${root}`))!;
    expect(row.replies).toBe(1);
    expect(row.doneAt).toBe(NOW.toISOString());
    expect(row.triage).toMatchObject({ priority: "P0", overridden: true });
  });

  it("after a rate limit, socket-triggered polls wait out the backoff; a refresh still forces one", async () => {
    const { inbox, slack } = setup({ searchError: "Slack rate limit on search.messages: retry after 30s" });
    await inbox.pollOnce();
    expect(slack.searchMentions).toHaveBeenCalledTimes(1);
    await inbox.pollOnce();
    expect(slack.searchMentions).toHaveBeenCalledTimes(1);
    await inbox.pollOnce(true);
    expect(slack.searchMentions).toHaveBeenCalledTimes(2);
  });

  it("a failed container leaves triage null and retries after 1, 5 and 15 minutes, then gives up", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const clock = { now: NOW };
      const calls: number[] = [];
      let failing = true;
      const triager: Triager = {
        triage: async (items) => {
          calls.push(clock.now.getTime());
          if (failing) throw new Error("docker: not running");
          return new Map(items.map((i) => [i.id, answerAll(i)]));
        },
      };
      const { inbox, store } = setup({ triager, hits: [hit({ ts: ts(10), text: "<@U1> hi?" })], now: () => clock.now });
      await poll(inbox);
      expect(calls).toHaveLength(1);
      expect((await store.item(`C1:${ts(10)}`))!.triage).toBeNull();
      // Not yet a minute later: nothing runs again.
      await poll(inbox);
      expect(calls).toHaveLength(1);
      clock.now = new Date(NOW.getTime() + 61_000);
      await poll(inbox);
      expect(calls).toHaveLength(2);
      clock.now = new Date(NOW.getTime() + 2 * 60_000);
      await poll(inbox);
      expect(calls).toHaveLength(2);
      clock.now = new Date(NOW.getTime() + 7 * 60_000);
      await poll(inbox);
      expect(calls).toHaveLength(3);
      clock.now = new Date(NOW.getTime() + 23 * 60_000);
      await poll(inbox);
      expect(calls).toHaveLength(4);
      expect((await store.item(`C1:${ts(10)}`))!.triage).toBeNull();
      // Out of tries: nothing more, ever, until a new message folds in.
      clock.now = new Date(NOW.getTime() + 60 * 60_000);
      failing = false;
      await poll(inbox);
      expect(calls).toHaveLength(4);
      expect(warn.mock.calls.some((c) => String(c[0]).includes("giving up"))).toBe(true);

      // A failure followed by a success: the verdict lands on the retry.
      const second = setup({ triager, hits: [hit({ ts: ts(9), text: "<@U1> again?" })], now: () => clock.now });
      failing = true;
      await poll(second.inbox);
      failing = false;
      clock.now = new Date(clock.now.getTime() + 61_000);
      await poll(second.inbox);
      expect((await second.store.item(`C1:${ts(9)}`))!.triage).toMatchObject({ by: "model", priority: "P1" });
    } finally {
      warn.mockRestore();
    }
  });

  it("start() queues the items a previous run left untriaged", async () => {
    vi.useFakeTimers({ now: NOW });
    const { inbox, store, triaged } = setup();
    try {
      const base = { ...(await fold()), id: "C1:old" };
      await store.save([base, { ...base, id: "C1:done", doneAt: iso(5) }, { ...base, id: "C1:triaged", triage: { priority: "P2", category: "fyi", expectsReply: false, summary: "", why: "", draft: null, refs: [], deadline: null, by: "rules", triagedAt: iso(5), overridden: false } }]);
      inbox.start();
      await vi.advanceTimersByTimeAsync(0);
      await inbox.idle();
      expect(triaged.flat().map((t) => t.id)).toEqual(["C1:old"]);
    } finally {
      inbox.stop();
      vi.useRealTimers();
    }
  });

  it("stamps doneAt on an FYI that aged out, and prunes done items past 30 days and old triage runs each poll", async () => {
    const { inbox, store } = setup({ hits: [hit({ ts: ts(8 * 24 * 60), text: "<@U1> fyi, shipped" })], retentionDays: 7 });
    const stale = { ...(await fold()), id: "C1:stale", doneAt: iso(31 * 24 * 60) };
    const kept = { ...(await fold()), id: "C1:kept", doneAt: iso(29 * 24 * 60) };
    await store.save([stale, kept]);
    const run = { endedAt: iso(0), items: 1, model: "m", turns: 1, costUsd: 0, ok: true, error: null };
    await store.recordTriageRun({ ...run, startedAt: iso(8 * 24 * 60) });
    await store.recordTriageRun({ ...run, startedAt: iso(6 * 24 * 60) });
    const { items } = await poll(inbox);
    const aged = items.find((i) => i.id === `C1:${ts(8 * 24 * 60)}`)!;
    expect(aged).toMatchObject({ split: "done", doneAt: NOW.toISOString() });
    expect((await store.item(aged.id))!.doneAt).toBe(NOW.toISOString());
    expect(await store.item("C1:stale")).toBeNull();
    expect(await store.item("C1:kept")).not.toBeNull();
    expect(store.runs.map((r) => r.startedAt)).toEqual([iso(6 * 24 * 60)]);
  });
});

/** A bare stored row, for tests that seed the store directly. */
async function fold(): Promise<SlackItemRow> {
  return {
    id: "C1:seed",
    kind: "mention",
    channel: { id: "C1", name: "eng", kind: "channel" },
    author: { id: "U2", name: "marta", isBot: false },
    text: "@higor earlier",
    threadTs: null,
    context: [],
    permalink: "",
    ts: iso(120),
    slackTs: ts(120),
    matched: ["me"],
    count: 1,
    replies: 0,
    youReplied: false,
    seenAt: null,
    doneAt: null,
    snoozedUntil: null,
    reopenedAt: null,
    triage: null,
    linked: { pr: null, taskId: null },
    arrivedAt: iso(120),
    repliedAt: null,
  };
}
