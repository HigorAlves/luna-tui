import type { SlackTriage, SlackWatch } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import { type IncomingMessage, type SlackItemRow, dueOf, fold, higher, inSnapshot, matchWatches, mentionsUser, prUrlsIn, splitOf, toSlackItem, touch, watchFloor } from "./slack-item.ts";
import { DEFAULT_SLA } from "./slack-rules.ts";

const now = new Date("2026-10-28T12:00:00Z");
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000).toISOString();

const triage = (over: Partial<SlackTriage> = {}): SlackTriage => ({
  priority: "P1",
  category: "question",
  expectsReply: true,
  summary: "answer them",
  why: "they asked",
  draft: null,
  refs: [],
  deadline: null,
  by: "model",
  triagedAt: now.toISOString(),
  overridden: false,
  ...over,
});

const row = (over: Partial<SlackItemRow> = {}): SlackItemRow => ({
  id: "C1:1.0",
  kind: "mention",
  channel: { id: "C1", name: "eng", kind: "channel" },
  author: { id: "U2", name: "marta", isBot: false },
  text: "hi",
  threadTs: null,
  context: [],
  permalink: "https://x.slack.com/archives/C1/p1",
  ts: hoursAgo(1),
  slackTs: "1.0",
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
  arrivedAt: hoursAgo(1),
  repliedAt: null,
  ...over,
});

describe("splitOf", () => {
  it("done wins, then snoozed, then needs_reply", () => {
    expect(splitOf(row({ doneAt: hoursAgo(0), triage: triage() }), now)).toBe("done");
    expect(splitOf(row({ snoozedUntil: hoursAgo(-2), triage: triage() }), now)).toBe("snoozed");
    expect(splitOf(row({ snoozedUntil: hoursAgo(2), triage: triage() }), now)).toBe("needs_reply");
    expect(splitOf(row({ triage: triage() }), now)).toBe("needs_reply");
  });

  it("a reply from you turns an ask into waiting on them after 24h, fyi before", () => {
    expect(splitOf(row({ triage: triage(), youReplied: true, ts: hoursAgo(25) }), now)).toBe("waiting_on_them");
    expect(splitOf(row({ triage: triage(), youReplied: true, ts: hoursAgo(2) }), now)).toBe("fyi");
  });

  it("blockers and decisions without an explicit ask go to decide; the rest is fyi", () => {
    expect(splitOf(row({ triage: triage({ expectsReply: false, category: "decision" }) }), now)).toBe("decide");
    expect(splitOf(row({ triage: triage({ expectsReply: false, category: "blocker" }) }), now)).toBe("decide");
    expect(splitOf(row({ triage: triage({ expectsReply: false, category: "fyi" }) }), now)).toBe("fyi");
    expect(splitOf(row(), now)).toBe("fyi");
  });

  it("an fyi nobody touched for a week is done", () => {
    expect(splitOf(row({ ts: hoursAgo(8 * 24) }), now)).toBe("done");
    expect(splitOf(row({ ts: hoursAgo(8 * 24), triage: triage() }), now)).toBe("needs_reply");
  });
});

const watch = (over: Partial<SlackWatch>): SlackWatch => ({
  id: "w",
  kind: "keyword",
  value: "luna",
  label: "luna",
  channels: [],
  enabled: true,
  builtin: false,
  priority: null,
  createdAt: now.toISOString(),
  ...over,
});

describe("matchWatches", () => {
  const watches = [
    watch({ id: "1", kind: "usergroup", value: "S04ABCD", label: "@platform-team", priority: "P1" }),
    watch({ id: "2", kind: "broadcast", value: "here", label: "@here", builtin: true }),
    watch({ id: "3", kind: "keyword", value: "Luna-TUI", channels: ["C1"] }),
    watch({ id: "4", kind: "channel", value: "C9", label: "#oncall", priority: "P3" }),
    watch({ id: "5", kind: "broadcast", value: "channel", enabled: false }),
  ];

  it("matches usergroups, broadcasts, keywords in their channels and channels", () => {
    expect(matchWatches("hey <!subteam^S04ABCD|@platform-team> look", "C1", watches)).toEqual(["usergroup:S04ABCD"]);
    expect(matchWatches("<!here> deploy", "C1", watches)).toEqual(["broadcast:here"]);
    expect(matchWatches("<!here|@here> deploy", "C1", watches)).toEqual(["broadcast:here"]);
    expect(matchWatches("the luna-tui board", "C1", watches)).toEqual(["keyword:Luna-TUI"]);
    expect(matchWatches("the luna-tui board", "C2", watches)).toEqual([]);
    expect(matchWatches("anything", "C9", watches)).toEqual(["channel:C9"]);
  });

  it("skips disabled watches and reports every match", () => {
    expect(matchWatches("<!channel> hi", "C1", watches)).toEqual([]);
    expect(matchWatches("<!here> luna-tui", "C1", watches)).toEqual(["broadcast:here", "keyword:Luna-TUI"]);
  });

  it("gives the floor of the matched watches", () => {
    expect(watchFloor(["usergroup:S04ABCD", "channel:C9"], watches)).toBe("P1");
    expect(watchFloor(["channel:C9"], watches)).toBe("P3");
    expect(watchFloor(["broadcast:here"], watches)).toBeNull();
    expect(higher("P2", "P0")).toBe("P0");
    expect(higher(null, "P3")).toBe("P3");
  });

  it("knows a mention of you", () => {
    expect(mentionsUser("<@U1> hi", "U1")).toBe(true);
    expect(mentionsUser("<@U1|higor> hi", "U1")).toBe(true);
    expect(mentionsUser("<@U12> hi", "U1")).toBe(false);
  });
});

const incoming = (over: Partial<IncomingMessage> = {}): IncomingMessage => ({
  id: "C1:1.0",
  kind: "mention",
  channel: { id: "C1", name: "eng", kind: "channel" },
  author: { id: "U2", name: "marta", isBot: false },
  text: "first",
  threadTs: null,
  context: [],
  permalink: "p1",
  ts: hoursAgo(1),
  slackTs: "1.0",
  matched: ["me"],
  ...over,
});

describe("fold", () => {
  it("makes a fresh item from a new message", () => {
    const { item, retriage } = fold(null, incoming(), now);
    expect(retriage).toBe(true);
    expect(item).toMatchObject({ id: "C1:1.0", count: 1, replies: 0, triage: null, doneAt: null, arrivedAt: now.toISOString() });
  });

  it("collapses a later message in the same thread: count up, latest text, merged reasons", () => {
    const first = fold(null, incoming(), now).item;
    const { item, retriage } = fold(first, incoming({ text: "second", slackTs: "2.0", ts: hoursAgo(0), matched: ["broadcast:here"], author: { id: "U3", name: "ana", isBot: false } }), now);
    expect(retriage).toBe(true);
    expect(item).toMatchObject({ count: 2, text: "second", slackTs: "2.0", matched: ["me", "broadcast:here"], author: { name: "ana" } });
  });

  it("ignores a message it already holds", () => {
    const first = fold(null, incoming({ slackTs: "2.0" }), now).item;
    const { item, retriage } = fold(first, incoming({ text: "older", slackTs: "1.0" }), now);
    expect(retriage).toBe(false);
    expect(item.text).toBe("first");
    expect(item.count).toBe(1);
  });

  it("reopens a cleared item when a new message lands, and asks for triage again", () => {
    const done = { ...fold(null, incoming(), now).item, doneAt: hoursAgo(2), youReplied: true, snoozedUntil: hoursAgo(-5) };
    const { item, retriage } = fold(done, incoming({ text: "again", slackTs: "3.0" }), now);
    expect(retriage).toBe(true);
    expect(item).toMatchObject({ doneAt: null, reopenedAt: now.toISOString(), youReplied: false, snoozedUntil: null, text: "again" });
  });
});

describe("touch", () => {
  it("does nothing when the thread did not move", () => {
    const item = row({ replies: 2 });
    expect(touch(item, { replies: 2, latestIsYours: false }, now)).toEqual({ item, retriage: false });
  });

  it("records your reply without re-triage, and a reply after yours with it", () => {
    const yours = touch(row({ replies: 1 }), { replies: 2, latestIsYours: true }, now);
    expect(yours.retriage).toBe(false);
    expect(yours.item).toMatchObject({ replies: 2, youReplied: true });
    const theirs = touch(yours.item, { replies: 3, latestIsYours: false, context: [{ ts: "2.0", user: { id: "U2", name: "marta", isBot: false }, text: "ok?" }] }, now);
    expect(theirs.retriage).toBe(true);
    expect(theirs.item).toMatchObject({ replies: 3, youReplied: false, context: [{ text: "ok?" }] });
  });

  it("reopens a cleared item when someone else replies", () => {
    const { item } = touch(row({ doneAt: hoursAgo(1), replies: 0 }), { replies: 1, latestIsYours: false }, now);
    expect(item).toMatchObject({ doneAt: null, reopenedAt: now.toISOString() });
    const mine = touch(row({ doneAt: hoursAgo(1), replies: 0 }), { replies: 1, latestIsYours: true }, now);
    expect(mine.item.doneAt).not.toBeNull();
  });
});

describe("snapshot membership and PR links", () => {
  it("keeps open items and those done within 30 days", () => {
    expect(inSnapshot(row(), now)).toBe(true);
    expect(inSnapshot(row({ doneAt: hoursAgo(29 * 24) }), now)).toBe(true);
    expect(inSnapshot(row({ doneAt: hoursAgo(31 * 24) }), now)).toBe(false);
  });

  it("finds PR urls in text", () => {
    expect(prUrlsIn("see https://github.com/o/a/pull/212 and https://github.com/o/b/pull/7|PR")).toEqual([
      { repo: "o/a", number: 212 },
      { repo: "o/b", number: 7 },
    ]);
  });
});

describe("dueOf and toSlackItem", () => {
  const asked = row({ ts: hoursAgo(1), triage: triage({ priority: "P1" }) });

  it("dues an open ask at its latest message plus the SLA of its priority, and marks it overdue once that passed", () => {
    // P1 at 30m: an hour-old ask was due half an hour ago.
    expect(dueOf(asked, now, DEFAULT_SLA)).toEqual({ dueAt: hoursAgo(0.5), overdue: true });
    expect(dueOf({ ...asked, triage: triage({ priority: "P2" }) }, now, DEFAULT_SLA)).toEqual({ dueAt: hoursAgo(0), overdue: false });
    expect(dueOf({ ...asked, triage: triage({ priority: "P0", overridden: true }) }, now, DEFAULT_SLA)).toEqual({ dueAt: hoursAgo(50 / 60), overdue: true });
    expect(dueOf(asked, now, { ...DEFAULT_SLA, P1: null })).toEqual({ dueAt: null, overdue: false });
  });

  it("has no due time when no reply is expected, you replied, it is done or still snoozed", () => {
    const none = { dueAt: null, overdue: false };
    expect(dueOf(row({ ts: hoursAgo(1) }), now, DEFAULT_SLA)).toEqual(none);
    expect(dueOf({ ...asked, triage: triage({ expectsReply: false }) }, now, DEFAULT_SLA)).toEqual(none);
    expect(dueOf({ ...asked, youReplied: true }, now, DEFAULT_SLA)).toEqual(none);
    expect(dueOf({ ...asked, doneAt: hoursAgo(0) }, now, DEFAULT_SLA)).toEqual(none);
    expect(dueOf({ ...asked, snoozedUntil: hoursAgo(-1) }, now, DEFAULT_SLA)).toEqual(none);
    // A snooze that passed counts again, from the message, not from the snooze.
    expect(dueOf({ ...asked, snoozedUntil: hoursAgo(0.25) }, now, DEFAULT_SLA)).toEqual({ dueAt: hoursAgo(0.5), overdue: true });
  });

  it("toSlackItem carries split, dueAt and overdue and drops the storage-only fields", () => {
    const item = toSlackItem(asked, now, DEFAULT_SLA);
    expect(item).toMatchObject({ id: asked.id, split: "needs_reply", dueAt: hoursAgo(0.5), overdue: true });
    expect(item).not.toHaveProperty("slackTs");
    expect(item).not.toHaveProperty("arrivedAt");
    expect(item).not.toHaveProperty("repliedAt");
  });
});
