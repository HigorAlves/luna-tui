import type { SlackItem, SlackMetrics, SlackSnapshot, SlackTriageRuns, SlackWatch } from "@hardness/contracts";
import type { DataSource } from "typeorm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { Pipeline } from "../../application/pipeline.ts";
import { AlreadyTaskError, BuiltinWatchError, NoItemError, NoWatchError, type SlackInboxPort } from "../../application/slack-inbox.ts";
import { NoSlackTokenError } from "../../application/slack.ts";
import { StubStages } from "../../application/stages/stubs.ts";
import type { TaskRow } from "../../domain/task.ts";
import { freshTestDatabase } from "../../test/database.ts";
import { createApp } from "./app.ts";
import { Bus } from "./bus.ts";

let db: DataSource;
let pipeline: Pipeline;

beforeAll(async () => {
  db = await freshTestDatabase();
});
afterAll(async () => {
  await db.destroy();
});
beforeEach(async () => {
  await db.query("truncate tasks cascade");
  pipeline = new Pipeline(db, new StubStages().runnerFor, { inline: true });
});

const item = (id: string, split: SlackItem["split"]): SlackItem => ({
  id,
  kind: "mention",
  channel: { id: "C1", name: "eng", kind: "channel" },
  author: { id: "U2", name: "marta", isBot: false },
  text: "can you approve?",
  threadTs: null,
  context: [],
  permalink: "https://x.slack.com/p1",
  ts: "2026-10-28T10:00:00Z",
  matched: ["me"],
  count: 1,
  replies: 0,
  youReplied: false,
  seenAt: null,
  doneAt: null,
  snoozedUntil: null,
  reopenedAt: null,
  dueAt: null,
  overdue: false,
  triage: null,
  split,
  linked: { pr: null, taskId: null },
});

const watch = (id: string, builtin: boolean): SlackWatch => ({ id, kind: builtin ? "broadcast" : "keyword", value: builtin ? "here" : "luna", label: builtin ? "@here" : "luna", channels: [], enabled: true, builtin, priority: null, createdAt: "2026-10-28T00:00:00Z" });

/** A fake inbox: a fixed snapshot, and a log of what the routes asked it to do. */
function fakeInbox(items: SlackItem[], over: { hasToken?: boolean } = {}): SlackInboxPort & { did: string[] } {
  const watches = [watch("w1", true), watch("w2", false)];
  const snapshot: SlackSnapshot = { items, watches, me: { id: "U1", name: "higor", isBot: false }, polledAt: "2026-10-28T12:00:00Z", error: null, socket: "off", sla: { P0: 600, P1: 1800, P2: 3600, P3: 3600 }, quiet: false };
  const did: string[] = [];
  const find = (id: string) => {
    const found = items.find((i) => i.id === id);
    if (!found) throw new NoItemError(id);
    return found;
  };
  return {
    did,
    get snapshot() {
      return snapshot;
    },
    async pollOnce() {
      did.push("poll");
      return snapshot;
    },
    async patch(id, patch) {
      const found = find(id);
      did.push(`patch ${id} ${JSON.stringify(patch)}`);
      return { ...found, ...(patch.done ? { doneAt: "2026-10-28T12:00:00Z", split: "done" as const } : {}) };
    },
    async reply(id, text, nudge) {
      const found = find(id);
      if (over.hasToken === false) throw new NoSlackTokenError();
      did.push(`reply ${id} ${text}${nudge ? " (nudge)" : ""}`);
      return { ...found, youReplied: true, split: "done" };
    },
    async toTask(id, input) {
      const found = find(id);
      if (found.linked.taskId) throw new AlreadyTaskError(id, found.linked.taskId);
      did.push(`task ${id} ${JSON.stringify(input)}`);
      return pipeline.createTask({ title: input.title ?? found.text, source: { kind: "slack", channel: "C1", ts: "1.0", permalink: found.permalink } });
    },
    async watches() {
      return watches;
    },
    async addWatch(input) {
      did.push(`add ${input.kind} ${input.value}`);
      return { ...watch("w3", false), ...input, label: input.label ?? input.value };
    },
    async patchWatch(id, patch) {
      const found = watches.find((w) => w.id === id);
      if (!found) throw new NoWatchError(id);
      did.push(`patch-watch ${id} ${JSON.stringify(patch)}`);
      return { ...found, ...patch } as SlackWatch;
    },
    async deleteWatch(id) {
      const found = watches.find((w) => w.id === id);
      if (!found) throw new NoWatchError(id);
      if (found.builtin) throw new BuiltinWatchError(found.label);
      did.push(`delete-watch ${id}`);
    },
    async metrics(since) {
      did.push(`metrics ${since.toISOString()}`);
      const zero = { P0: 0, P1: 0, P2: 0, P3: 0 };
      const none = { median: null, p90: null };
      return { since: since.toISOString(), items: zero, replied: zero, withinHour: 0, withinSla: zero, sla: { P0: 600, P1: 1800, P2: 3600, P3: 3600 }, timeToReply: { P0: none, P1: none, P2: none, P3: none }, byDay: [] } satisfies SlackMetrics;
    },
    async triageRuns(since) {
      did.push(`triage-runs ${since.toISOString()}`);
      const run = { id: "r1", startedAt: "2026-10-28T11:00:00Z", endedAt: "2026-10-28T11:00:20Z", items: 3, model: "claude-haiku-5-5", turns: 1, costUsd: 0.0042, ok: true, error: null };
      return { since: since.toISOString(), runs: [run], items: 3, costUsd: 0.0042 } satisfies SlackTriageRuns;
    },
    async digest() {
      return "digest";
    },
    async usergroups() {
      return [{ id: "S1", handle: "platform-team", name: "Platform" }];
    },
    async channels() {
      return [{ id: "C1", name: "eng", kind: "channel" }];
    },
  };
}

const json = (method: string, body: unknown) => ({ method, body: JSON.stringify(body), headers: { "content-type": "application/json" } });

describe("the Slack inbox over HTTP", () => {
  it("serves the snapshot and polls on demand", async () => {
    const slack = fakeInbox([item("C1:1", "needs_reply")]);
    const app = createApp({ db, pipeline, bus: new Bus(), slack });
    const got = await app.request("/slack/items");
    expect(got.status).toBe(200);
    expect(await got.json()).toMatchObject({ items: [{ id: "C1:1", split: "needs_reply" }], watches: [{ id: "w1" }, { id: "w2" }], socket: "off" });
    expect((await app.request("/slack/refresh", { method: "POST" })).status).toBe(200);
    expect(slack.did).toEqual(["poll"]);
  });

  it("patches an item, 404 no_item for an unknown one, 400 for a bad body", async () => {
    const slack = fakeInbox([item("C1:1", "needs_reply")]);
    const app = createApp({ db, pipeline, bus: new Bus(), slack });
    const done = await app.request("/slack/items/C1:1", json("PATCH", { done: true }));
    expect(done.status).toBe(200);
    expect(await done.json()).toMatchObject({ split: "done" });
    const missing = await app.request("/slack/items/C1:9", json("PATCH", { done: true }));
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: "no_item" });
    expect((await app.request("/slack/items/C1:1", json("PATCH", { priority: "P9" }))).status).toBe(400);
    expect(slack.did).toEqual(['patch C1:1 {"done":true}']);
  });

  it("replies as you, or 409 no_token when it cannot", async () => {
    const slack = fakeInbox([item("C1:1", "needs_reply")]);
    const app = createApp({ db, pipeline, bus: new Bus(), slack });
    const sent = await app.request("/slack/items/C1:1/reply", json("POST", { text: "Approved." }));
    expect(sent.status).toBe(200);
    expect(await sent.json()).toMatchObject({ youReplied: true, split: "done" });
    expect((await app.request("/slack/items/C1:1/reply", json("POST", { text: "" }))).status).toBe(400);
    // The board percent-encodes the id's colon; a nudge rides as a flag.
    expect((await app.request("/slack/items/C1%3A1/reply", json("POST", { text: "any news?", nudge: true }))).status).toBe(200);
    expect((await app.request("/slack/items/C1%3A1", json("PATCH", { seen: true }))).status).toBe(200);
    expect(slack.did).toEqual(["reply C1:1 Approved.", "reply C1:1 any news? (nudge)", 'patch C1:1 {"seen":true}']);
    const silent = createApp({ db, pipeline, bus: new Bus(), slack: fakeInbox([item("C1:1", "needs_reply")], { hasToken: false }) });
    const refused = await silent.request("/slack/items/C1:1/reply", json("POST", { text: "hi" }));
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: "no_token" });
  });

  it("makes a task from an item once", async () => {
    const linked = { ...item("C1:2", "fyi"), linked: { pr: null, taskId: "t1" } };
    const slack = fakeInbox([item("C1:1", "needs_reply"), linked]);
    const app = createApp({ db, pipeline, bus: new Bus(), slack });
    const created = await app.request("/slack/items/C1:1/task", json("POST", { title: "Approve it", repoPath: "/r/a" }));
    expect(created.status).toBe(201);
    const task = (await created.json()) as TaskRow & { source: unknown };
    expect(task).toMatchObject({ title: "Approve it", state: "draft", source: { kind: "slack", channel: "C1" } });
    const again = await app.request("/slack/items/C1:2/task", json("POST", {}));
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: "already_task" });
  });

  it("lists, adds, patches and deletes watches; builtins answer 409", async () => {
    const slack = fakeInbox([]);
    const app = createApp({ db, pipeline, bus: new Bus(), slack });
    expect(await (await app.request("/slack/watches")).json()).toHaveLength(2);
    const added = await app.request("/slack/watches", json("POST", { kind: "usergroup", value: "S1" }));
    expect(added.status).toBe(201);
    expect(await added.json()).toMatchObject({ kind: "usergroup", value: "S1", channels: [], priority: null });
    expect((await app.request("/slack/watches", json("POST", { kind: "nope", value: "x" }))).status).toBe(400);
    expect((await app.request("/slack/watches/w2", json("PATCH", { enabled: false }))).status).toBe(200);
    expect((await app.request("/slack/watches/w9", json("PATCH", { enabled: false }))).status).toBe(404);
    expect((await app.request("/slack/watches/w2", { method: "DELETE" })).status).toBe(204);
    const builtin = await app.request("/slack/watches/w1", { method: "DELETE" });
    expect(builtin.status).toBe(409);
    expect(await builtin.json()).toMatchObject({ error: "builtin" });
    expect(slack.did).toEqual(["add usergroup S1", 'patch-watch w2 {"enabled":false}', "delete-watch w2"]);
  });

  it("answers metrics for a window and the listings for autocomplete", async () => {
    const slack = fakeInbox([]);
    const app = createApp({ db, pipeline, bus: new Bus(), slack });
    const metrics = await app.request("/slack/metrics?since=30d");
    expect(metrics.status).toBe(200);
    expect(await metrics.json()).toMatchObject({ items: { P0: 0 }, byDay: [] });
    expect((await app.request("/slack/metrics?since=soon")).status).toBe(400);
    const runs = await app.request("/slack/triage-runs?since=30d");
    expect(runs.status).toBe(200);
    expect(await runs.json()).toMatchObject({ items: 3, costUsd: 0.0042, runs: [{ id: "r1", model: "claude-haiku-5-5", ok: true }] });
    expect(slack.did.filter((d) => d.startsWith("triage-runs"))).toHaveLength(1);
    expect((await app.request("/slack/triage-runs?since=soon")).status).toBe(400);
    expect(await (await app.request("/slack/usergroups")).json()).toEqual([{ id: "S1", handle: "platform-team", name: "Platform" }]);
    expect(await (await app.request("/slack/channels")).json()).toEqual([{ id: "C1", name: "eng", kind: "channel" }]);
  });

  it("answers 404 for the inbox when it is off", async () => {
    const app = createApp({ db, pipeline, bus: new Bus() });
    expect((await app.request("/slack/items")).status).toBe(404);
  });
});
