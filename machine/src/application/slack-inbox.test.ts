import type { SlackSnapshot } from "@hardness/contracts";
import { describe, expect, it, vi } from "vitest";

import { RULES_TEMPLATE } from "../domain/slack-rules.ts";
import type { TaskRow } from "../domain/task.ts";
import { MemorySlackStore, fakeSlack } from "../test/slack.ts";
import { AlreadyTaskError, BuiltinWatchError, NoItemError, SlackInbox } from "./slack-inbox.ts";
import { NoSlackTokenError, type RawMessage, type SearchHit, noTokenSlack } from "./slack.ts";
import type { TriageAnswer, TriageItem, Triager } from "./slack-triage.ts";

const NOW = new Date("2026-10-28T12:00:00Z");
/** A Slack ts `minutes` before NOW. */
const ts = (minutes: number): string => ((NOW.getTime() - minutes * 60_000) / 1000).toFixed(6);
const iso = (minutes: number): string => new Date(NOW.getTime() - minutes * 60_000).toISOString();

const USERS: Record<string, { name: string; isBot: boolean }> = { U1: { name: "higor", isBot: false }, U2: { name: "marta", isBot: false }, U3: { name: "ana", isBot: false }, UB: { name: "deploybot", isBot: true } };
const CHANNELS: Record<string, { name: string; kind: "channel" | "group" | "dm" | "mpim" }> = { C1: { name: "eng", kind: "channel" }, C9: { name: "payments-oncall", kind: "channel" }, CR: { name: "random", kind: "channel" }, D1: { name: "U2", kind: "dm" } };

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
}

const msg = (over: Partial<RawMessage> & { ts: string }): RawMessage => ({ user: "U2", botId: null, text: "", subtype: null, threadTs: null, replyCount: 0, latestReply: null, ...over });
const hit = (over: Partial<SearchHit> & { ts: string }): SearchHit => ({ text: "<@U1> hi", user: "U2", channel: { id: "C1", name: "eng" }, permalink: `https://x.slack.com/archives/C1/p${over.ts.replace(".", "")}`, ...over });

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
    intervalMs: 60_000,
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
    rulesPath: "/rules.md",
    socketToken: null,
    now: () => NOW,
    files: { read: async (p) => files.get(p) ?? null, write: async (p, t) => void files.set(p, t) },
  });
  return { inbox, slack, store, published, triaged, files, created };
}

describe("SlackInbox.pollOnce", () => {
  it("turns mentions into triaged items with the builtin watches, publishes once, then only on change", async () => {
    const { inbox, published, triaged, slack } = setup({ hits: [hit({ ts: ts(10), text: "<@U1> can you review https://github.com/o/a/pull/212?" })], linkPr: { repo: "o/a", number: 212, split: "review_requested" } });
    const snapshot = await inbox.pollOnce();
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
    expect(triaged[0]![0]).toMatchObject({ id: item.id, channel: "#eng", author: "@marta", matched: ["me"] });
    expect(published).toHaveLength(1);
    await inbox.pollOnce();
    expect(published).toHaveLength(1);
    // The second poll searches since the newest hit.
    const searches = slack.calls.filter((c) => c[0] === "searchMentions");
    expect(searches[1]![2]).toBe(ts(10));
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
    const { items } = await inbox.pollOnce();
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
    const { items } = await inbox.pollOnce();
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
    let { items } = await inbox.pollOnce();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: `C1:${root}`, count: 2, text: "@higor second ask", replies: 2, youReplied: false, threadTs: null });
    expect(items[0]!.context.map((m) => m.text)).toEqual(["I think so"]);

    // You answer in Slack itself: youReplied, no re-triage; then someone replies again: reopened ask.
    world.replies![`C1:${root}`]!.push(msg({ ts: ts(40), user: "U1", text: "done" }));
    ({ items } = await inbox.pollOnce());
    expect(items[0]).toMatchObject({ replies: 3, youReplied: true, split: "fyi" });
    await inbox.patch(items[0]!.id, { done: true });
    world.replies![`C1:${root}`]!.push(msg({ ts: ts(30), user: "U3", text: "<@U1> one more?" }));
    ({ items } = await inbox.pollOnce());
    expect(items[0]).toMatchObject({ replies: 4, youReplied: false, doneAt: null, reopenedAt: NOW.toISOString(), count: 3, text: "@higor one more?", split: "needs_reply" });
    expect(store.rows.size).toBe(1);
  });

  it("reports an error, keeps the items, and backs off on a rate limit", async () => {
    const { inbox, published } = setup({ hits: [hit({ ts: ts(1) })] });
    await inbox.pollOnce();
    const world = { searchError: "Slack rate limit on search.messages: retry after 30s" };
    const limited = setup(world);
    const snapshot = await limited.inbox.pollOnce();
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
      const { items } = await inbox.pollOnce();
      expect(files.get("/rules.md")).toBe(RULES_TEMPLATE);
      expect(log).toHaveBeenCalledWith(expect.stringContaining("wrote the default rules file to /rules.md"));
      expect(items[0]!.triage).toBeNull();
      expect(items[0]!.split).toBe("fyi");
      await inbox.pollOnce();
      expect(warn.mock.calls.filter((c) => String(c[0]).includes("without triage"))).toHaveLength(1);
    } finally {
      warn.mockRestore();
      log.mockRestore();
    }
  });

  it("gives an item the model skipped a rules fallback", async () => {
    const { inbox } = setup({ hits: [hit({ ts: ts(2), text: "<@U1> fyi" })], answer: () => null });
    const { items } = await inbox.pollOnce();
    expect(items[0]!.triage).toMatchObject({ priority: "P2", category: "fyi", by: "rules", summary: "@higor fyi" });
  });
});

describe("SlackInbox actions", () => {
  async function seeded(world: World = {}) {
    const w = setup({ hits: [hit({ ts: ts(30), text: "<@U1> can you approve?" })], ...world });
    const { items } = await w.inbox.pollOnce();
    return { ...w, item: items[0]! };
  }

  it("patch: done clears (marking Slack only when told), learns a lowered prior, reopens, snoozes, overrides priority", async () => {
    const { inbox, item, slack, files } = await seeded();
    let patched = await inbox.patch(item.id, { done: true });
    expect(patched).toMatchObject({ doneAt: NOW.toISOString(), split: "done" });
    expect(slack.mark).not.toHaveBeenCalled();
    expect(files.get("/rules.md")).toContain("- @marta: lowered (1)");
    patched = await inbox.patch(item.id, { done: false });
    expect(patched).toMatchObject({ doneAt: null, split: "needs_reply" });
    patched = await inbox.patch(item.id, { snoozedUntil: iso(-60), seen: true });
    expect(patched).toMatchObject({ split: "snoozed", seenAt: NOW.toISOString() });
    patched = await inbox.patch(item.id, { snoozedUntil: null, priority: "P0" });
    expect(patched.triage).toMatchObject({ priority: "P0", overridden: true });
    expect(patched.split).toBe("needs_reply");
    // A re-triage keeps the override.
    await inbox.pollOnce();
    expect(inbox.snapshot.items[0]!.triage).toMatchObject({ priority: "P0", overridden: true });
    await expect(inbox.patch("C1:nope", { done: true })).rejects.toThrow(NoItemError);

    const marking = await seeded({ markRead: true });
    await marking.inbox.patch(marking.item.id, { done: true });
    expect(marking.slack.mark).toHaveBeenCalledWith("C1", ts(30));
  });

  it("reply posts in the thread as you, clears the item and learns a raised prior for a quick answer", async () => {
    const { inbox, item, slack, files, published } = await seeded();
    const before = published.length;
    const replied = await inbox.reply(item.id, "Approved.");
    expect(slack.postMessage).toHaveBeenCalledWith("C1", "Approved.", ts(30));
    expect(replied).toMatchObject({ doneAt: NOW.toISOString(), youReplied: true, split: "done" });
    expect(files.get("/rules.md")).toContain("- @marta: raised (1)");
    expect(published.length).toBe(before + 1);
    const metrics = await inbox.metrics(new Date(NOW.getTime() - 86_400_000));
    expect(metrics).toMatchObject({ items: { P0: 0, P1: 1, P2: 0, P3: 0 }, replied: { P1: 1 }, withinHour: 1, timeToReply: { P1: { median: 1800, p90: 1800 } } });
    expect(metrics.byDay).toEqual([{ day: "2026-10-28", items: 1, replied: 1 }]);
  });

  it("reply in a thread uses the parent ts, and without a token fails with NoSlackTokenError", async () => {
    const root = ts(90);
    const { inbox, item, store, slack } = await seeded({ hits: [hit({ ts: ts(30), text: "<@U1> ok?", permalink: `https://x.slack.com/p?thread_ts=${root}&cid=C1` })] });
    expect(item.threadTs).toBe(root);
    expect(item.id).toBe(`C1:${root}`);
    await inbox.reply(item.id, "yes");
    expect(slack.postMessage).toHaveBeenCalledWith("C1", "yes", root);
    const silent = new SlackInbox({ slack: noTokenSlack(), triager: null, store, intervalMs: 1, publish: () => {}, findTask: async () => null, linkPr: () => null, createTask: async () => ({}) as TaskRow, markRead: false, rulesPath: "/r", socketToken: null, now: () => NOW, files: { read: async () => "", write: async () => {} } });
    await expect(silent.reply(item.id, "x")).rejects.toThrow(NoSlackTokenError);
    const snapshot = await silent.pollOnce();
    expect(snapshot.error).toMatch(/MACHINE_SLACK_USER_TOKEN/);
  });

  it("toTask creates a Backlog task from the item and links it once", async () => {
    const { inbox, item, created } = await seeded();
    const task = await inbox.toTask(item.id, { repoPath: "/r/a" });
    expect(created[0]).toEqual({
      title: "re: @higor can you appro",
      description: `From Slack: @marta in #eng · ${item.permalink}\n\n> @marta: @higor can you approve?`,
      repoPath: "/r/a",
      source: { kind: "slack", channel: "C1", ts: ts(30), permalink: item.permalink },
    });
    expect(inbox.snapshot.items[0]!.linked.taskId).toBe(task.id);
    await expect(inbox.toTask(item.id, {})).rejects.toThrow(AlreadyTaskError);
    const titled = await seeded();
    await titled.inbox.toTask(titled.item.id, { title: "Approve the thing" });
    expect(titled.created[0]).toMatchObject({ title: "Approve the thing", repoPath: null });
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
      "Needs reply: 1 (1 at P0/P1)",
      "- P0 #eng @marta: re: @higor can you appro",
      "Waiting on them: 1",
      "- P? #payments-oncall @marta: @higor can you approve?",
      "Last 24h: 1 item(s), 0 answered within the hour",
    ]);
    await inbox.postDigest();
    expect(slack.openDm).toHaveBeenCalledWith("U1");
    expect(slack.postMessage).toHaveBeenCalledWith("D1", text);
  });

  it("socket events flag channels for the next poll and queue reactions to your messages", async () => {
    const { inbox, slack } = await seeded({ history: { C9: [msg({ ts: ts(1), text: "<@U1> via socket" })] } });
    slack.history.mockClear();
    inbox.handleSocketEvent({ type: "message", channel: "C9", ts: ts(1), user: "U2", text: "<@U1> via socket" });
    inbox.handleSocketEvent({ type: "reaction_added", user: "U3", reaction: "eyes", item_user: "U1", item: { type: "message", channel: "C1", ts: ts(5) }, event_ts: ts(0) });
    inbox.handleSocketEvent({ type: "reaction_added", user: "U3", reaction: "eyes", item_user: "U2", item: { type: "message", channel: "C1", ts: ts(4) }, event_ts: ts(0) });
    inbox.stop();
    const { items } = await inbox.pollOnce();
    expect(slack.history).toHaveBeenCalledWith("C9", expect.any(String), 100);
    expect(items.map((i) => [i.kind, i.text])).toEqual(expect.arrayContaining([["mention", "@higor via socket"], ["reaction", ":eyes: on your message from @ana"]]));
    expect(items).toHaveLength(3);
  });
});
