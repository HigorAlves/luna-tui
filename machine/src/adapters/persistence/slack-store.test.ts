import type { DataSource } from "typeorm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { SlackItemRow } from "../../domain/slack-item.ts";
import { freshTestDatabase } from "../../test/database.ts";
import { PgSlackStore } from "./slack-store.ts";

let db: DataSource;
let store: PgSlackStore;

beforeAll(async () => {
  db = await freshTestDatabase();
  store = new PgSlackStore(db);
});
afterAll(async () => {
  await db.destroy();
});
beforeEach(async () => {
  await db.query("truncate slack_items, slack_watches");
});

const now = new Date("2026-10-28T12:00:00Z");
const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000).toISOString();

const row = (id: string, over: Partial<SlackItemRow> = {}): SlackItemRow => ({
  id,
  kind: "mention",
  channel: { id: "C1", name: "eng", kind: "channel" },
  author: { id: "U2", name: "marta", isBot: false },
  text: "hi",
  threadTs: null,
  context: [{ ts: "0.5", user: { id: "U2", name: "marta", isBot: false }, text: "earlier" }],
  permalink: "https://x.slack.com/p1",
  ts: daysAgo(1),
  slackTs: "1730000000.000100",
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
  arrivedAt: daysAgo(1),
  repliedAt: null,
  ...over,
});

describe("PgSlackStore items", () => {
  it("saves, replaces and reads items back unchanged", async () => {
    await store.save([row("C1:1"), row("C1:2", { slackTs: "1730000001.000100", ts: daysAgo(3), doneAt: daysAgo(2) })]);
    await store.save([row("C1:1", { text: "edited", count: 2, triage: { priority: "P1", category: "question", expectsReply: true, summary: "s", why: "w", draft: null, refs: [], deadline: null, by: "model", triagedAt: now.toISOString(), overridden: false } })]);
    const all = await store.items(new Date(0));
    expect(all.map((r) => r.id)).toEqual(["C1:1", "C1:2"]);
    expect(all[0]).toEqual(row("C1:1", { text: "edited", count: 2, triage: expect.objectContaining({ priority: "P1" }) as never }));
    expect(await store.item("C1:2")).toMatchObject({ doneAt: daysAgo(2) });
    expect(await store.item("nope")).toBeNull();
    expect(await store.latestTs()).toBe("1730000001.000100");
  });

  it("keeps open items and done ones after the cutoff only", async () => {
    await store.save([row("a"), row("b", { doneAt: daysAgo(10) }), row("c", { doneAt: daysAgo(40) })]);
    expect((await store.items(new Date(now.getTime() - 30 * 86_400_000))).map((r) => r.id).sort()).toEqual(["a", "b"]);
    expect(await new PgSlackStore(db).latestTs()).toBe("1730000000.000100");
  });

  it("answers the metric rows in a window", async () => {
    await store.save([
      row("a", { arrivedAt: daysAgo(1), repliedAt: daysAgo(0), triage: { priority: "P0", category: "blocker", expectsReply: true, summary: "", why: "", draft: null, refs: [], deadline: null, by: "model", triagedAt: now.toISOString(), overridden: false } }),
      row("b", { arrivedAt: daysAgo(9) }),
    ]);
    expect(await store.metricRows(new Date(now.getTime() - 7 * 86_400_000))).toEqual([{ ts: daysAgo(1), arrivedAt: daysAgo(1), repliedAt: daysAgo(0), priority: "P0", expectsReply: true }]);
    expect(await store.latestTs()).toBe("1730000000.000100");
  });

  it("starts empty", async () => {
    expect(await store.latestTs()).toBeNull();
    expect(await store.items(now)).toEqual([]);
  });
});

describe("PgSlackStore watches", () => {
  it("adds, patches, lists and deletes watches; kind+value is unique", async () => {
    const here = await store.addWatch({ kind: "broadcast", value: "here", label: "@here", channels: [], priority: null, builtin: true });
    const word = await store.addWatch({ kind: "keyword", value: "luna", label: "luna", channels: ["C1"], priority: "P2" });
    expect(here).toMatchObject({ kind: "broadcast", value: "here", builtin: true, enabled: true, priority: null });
    expect(word).toMatchObject({ kind: "keyword", channels: ["C1"], priority: "P2", builtin: false });
    expect(typeof word.createdAt).toBe("string");
    await expect(store.addWatch({ kind: "keyword", value: "luna", label: "again", channels: [], priority: null })).rejects.toThrow();
    const patched = await store.patchWatch(word.id, { enabled: false, priority: null, label: "Luna" });
    expect(patched).toMatchObject({ id: word.id, enabled: false, priority: null, label: "Luna", channels: ["C1"] });
    expect(await store.patchWatch("00000000-0000-0000-0000-000000000000", { enabled: true })).toBeNull();
    expect((await store.watches()).map((w) => w.value)).toEqual(["here", "luna"]);
    await store.deleteWatch(word.id);
    expect((await store.watches()).map((w) => w.value)).toEqual(["here"]);
  });
});
