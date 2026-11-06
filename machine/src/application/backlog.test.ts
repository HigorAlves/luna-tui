// The shared backlog: stored, ranked, bumped, promoted into a card or declined, over HTTP.
import type { DataSource } from "typeorm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../adapters/http/app.ts";
import { Bus } from "../adapters/http/bus.ts";
import { PgBacklogStore } from "../adapters/persistence/backlog-store.ts";
import { cardOf } from "../domain/card-fields.ts";
import { freshTestDatabase } from "../test/database.ts";
import { Backlog } from "./backlog.ts";
import { Pipeline } from "./pipeline.ts";
import { StubStages } from "./stages/stubs.ts";

let db: DataSource;
const stubs = new StubStages();
let pipeline: Pipeline;
let backlog: Backlog;

beforeAll(async () => {
  db = await freshTestDatabase();
});
afterAll(async () => {
  await db.destroy();
});
beforeEach(async () => {
  await db.query("truncate tasks cascade");
  await db.query("truncate backlog_items");
  stubs.reset();
  pipeline = new Pipeline(db, stubs.runnerFor, { inline: true, hasConfig: () => true });
  backlog = new Backlog({ store: new PgBacklogStore(db), pipeline, staleDays: 14 });
});

const app = () => createApp({ db, pipeline, bus: new Bus(), backlog });
const call = async (method: string, path: string, body?: unknown) => {
  const response = await app().request(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }) });
  return { status: response.status, body: (await response.json()) as any };
};
const top = { who: 3, what: 3, impact: 3, time: 3, demand: 1 };
const add = (title: string, over: Record<string, unknown> = {}) => call("POST", "/backlog", { title, text: `${title} text`, scores: top, size: "M", ...over });

describe("the backlog routes", () => {
  it("adds items from any source and lists them ranked, with the score and the stale mark", async () => {
    const slow = await add("Slow and big", { size: "XL", sources: [{ type: "slack", permalink: "https://example.slack.com/archives/C1/p1" }] });
    const quick = await add("Quick win", { size: "XS", sources: [{ kind: "github", repo: "o/a", number: 3, url: "https://github.com/o/a/issues/3" }] });
    expect(slow.status).toBe(201);
    const listed = await call("GET", "/backlog");
    expect(listed.body.map((e: any) => [e.title, e.score, e.stale])).toEqual([["Quick win", 1.833, false], ["Slow and big", 0.611, false]]);
    expect(listed.body[0]).toMatchObject({ id: quick.body.id, demand: 1, size: "XS", dependsOn: [] });
    await db.query("update backlog_items set assessed_at = now() - interval '15 days' where id = $1", [slow.body.id]);
    expect((await call("GET", "/backlog")).body.find((e: any) => e.id === slow.body.id).stale).toBe(true);
  });

  it("refuses a body that is not bounded", async () => {
    expect((await call("POST", "/backlog", { title: "", scores: top, size: "M" })).status).toBe(400);
    expect((await call("POST", "/backlog", { title: "x", scores: { ...top, who: 9 }, size: "M" })).status).toBe(400);
  });

  it("bump raises the demand, re-ranks and marks the item assessed", async () => {
    const a = await add("A");
    await db.query("update backlog_items set assessed_at = now() - interval '30 days' where id = $1", [a.body.id]);
    const bumped = await call("POST", `/backlog/${a.body.id}/bump`);
    expect(bumped.body).toMatchObject({ demand: 2, stale: false });
    expect(bumped.body.score).toBe(0.958);
  });

  it("promote makes a card with the item's scores as hints and removes the item", async () => {
    const a = await add("Make it a card", { sources: [{ kind: "github", repo: "o/a", number: 3, url: "https://github.com/o/a/issues/3" }] });
    const promoted = await call("POST", `/backlog/${a.body.id}/promote`);
    expect(promoted.status).toBe(201);
    const row = await pipeline.get(promoted.body.id);
    expect(row).toMatchObject({ title: "Make it a card", description: "Make it a card text", state: "draft" });
    expect(row.source).toMatchObject({ kind: "github", number: 3 });
    expect(cardOf(row).hints).toMatchObject({ size: "M", urgency: "3" });
    expect((await call("GET", "/backlog")).body).toEqual([]);
    expect((await call("POST", `/backlog/${a.body.id}/promote`)).status).toBe(404);
  });

  it("two promotes of one item at once make one card", async () => {
    const a = await add("Race me");
    const both = await Promise.all([call("POST", `/backlog/${a.body.id}/promote`), call("POST", `/backlog/${a.body.id}/promote`)]);
    expect(both.map((r) => r.status).sort()).toEqual([201, 404]);
    expect(await pipeline.list()).toHaveLength(1);
  });

  it("decline removes the item; an unknown item is 404", async () => {
    const a = await add("Nope");
    expect((await call("POST", `/backlog/${a.body.id}/decline`)).status).toBe(200);
    expect((await call("GET", "/backlog")).body).toEqual([]);
    expect((await call("POST", `/backlog/${a.body.id}/decline`)).status).toBe(404);
    expect((await call("POST", "/backlog/not-a-uuid/bump")).status).toBe(404);
  });
});

describe("a candidate that comes from a ticket", () => {
  const source = { kind: "jira" as const, key: "PAY-12", url: "https://x/PAY-12", issueType: "Task" };
  const input = (over: Record<string, unknown> = {}) => ({ title: "Refund", text: "t", sources: [source], repo: null, scores: top, size: "M" as const, dependsOn: [], ...over }) as never;

  it("is added once and updated, not added twice, when it comes again with new scores", async () => {
    const first = await backlog.upsertFromSource(input(), { createIfMissing: true });
    expect(first).toMatchObject({ created: true });
    const again = await backlog.upsertFromSource(input({ scores: { ...top, who: 1 }, size: "L" }), { createIfMissing: true });
    expect(again).toMatchObject({ created: false, id: first!.id });
    const list = await backlog.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ size: "L", scores: { who: 1 }, demand: 1 });
  });

  it("knows a Slack thread by its channel and root ts: the same thread updates its item, another thread adds one", async () => {
    const slack = (ts: string) => ({ kind: "slack" as const, channel: "C1", ts, permalink: `https://x.slack.com/p${ts}` });
    const first = await backlog.upsertFromSource(input({ sources: [slack("1.1")] }), { createIfMissing: true });
    const again = await backlog.upsertFromSource(input({ sources: [slack("1.1")], size: "L" }), { createIfMissing: true });
    expect(again).toMatchObject({ created: false, id: first!.id });
    const other = await backlog.upsertFromSource(input({ sources: [slack("2.2")] }), { createIfMissing: true });
    expect(other).toMatchObject({ created: true });
    expect(await backlog.list()).toHaveLength(2);
  });

  it("is not created by a re-assessment that finds no item", async () => {
    expect(await backlog.upsertFromSource(input(), { createIfMissing: false })).toBeNull();
    expect(await backlog.list()).toHaveLength(0);
  });

  it("tells the ticket machine when an item is declined, after removing it", async () => {
    const seen: string[] = [];
    const withHook = new Backlog({ store: new PgBacklogStore(db), pipeline, staleDays: 14, onDecline: async (row) => void seen.push(row.title) });
    const item = (await withHook.upsertFromSource(input(), { createIfMissing: true }))!;
    await withHook.decline(item.id);
    expect(seen).toEqual(["Refund"]);
    expect(await withHook.list()).toHaveLength(0);
  });
});

describe("the dependency rule in the backlog (wave 15)", () => {
  const GONE = "00000000-0000-4000-8000-00000000dead";
  const card = async (state: string, delivered = false) => {
    const task = await pipeline.createTask({ title: `A ${state} card`, description: "t", repoPath: "/repos/a" });
    await db.query("update tasks set state = $2, branch = 'task/x' where id = $1", [task.id, state]);
    if (delivered) await db.query("insert into stage_runs (task_id, stage, attempt, outcome, detail, started_at, finished_at) values ($1, 'delivering', 1, 'pass', $2, now(), now())", [task.id, JSON.stringify({ prNumber: 4 })]).catch(() => undefined);
    return task;
  };

  it("an item with no dependencies is listed schedulable and promoted exactly as before", async () => {
    const a = await add("Free");
    expect((await call("GET", "/backlog")).body[0]).toMatchObject({ id: a.body.id, schedulable: true, blockedBy: [] });
    const promoted = await call("POST", `/backlog/${a.body.id}/promote`);
    expect(promoted.status).toBe(201);
    expect(cardOf(await pipeline.get(promoted.body.id)).dependsOn).toBeUndefined();
  });

  it("an item that names an item still in the list, or a card that is not ready, is blocked and says by what", async () => {
    const first = await add("First");
    const running = await card("building");
    const second = await add("Second", { dependsOn: [first.body.id, running.id] });
    const entry = (await call("GET", "/backlog")).body.find((e: any) => e.id === second.body.id);
    expect(entry.schedulable).toBe(false);
    expect(entry.blockedBy).toEqual(expect.arrayContaining([{ id: first.body.id, kind: "item", state: "in the backlog" }, { id: running.id, kind: "card", state: "building" }]));
  });

  it("an id that is neither a card nor an item is gone and does not block", async () => {
    const a = await add("Orphan dependency", { dependsOn: [GONE] });
    expect((await call("GET", "/backlog")).body[0]).toMatchObject({ id: a.body.id, schedulable: true, blockedBy: [] });
  });

  it("a closed dependency does not block", async () => {
    const done = await card("closed");
    const a = await add("After a merged card", { dependsOn: [done.id] });
    expect((await call("GET", "/backlog")).body[0]).toMatchObject({ id: a.body.id, schedulable: true });
  });

  it("fails closed: when the states of its dependencies cannot be read, an item with dependencies is not schedulable and promote refuses", async () => {
    const done = await card("closed");
    const a = await add("After a card", { dependsOn: [done.id] });
    const broken = new Backlog({ store: new PgBacklogStore(db), pipeline: { createTask: (i) => pipeline.createTask(i), dependencyStates: async () => { throw new Error("the database blinked"); } }, staleDays: 14 });
    const entry = (await broken.list()).find((e) => e.id === a.body.id)!;
    expect(entry.schedulable).toBe(false);
    expect(entry.blockedBy).toEqual([{ id: done.id, kind: "card", state: "unreadable" }]);
    await expect(broken.promote(a.body.id)).rejects.toMatchObject({ name: "NotSchedulableError" });
    expect(await pipeline.list()).toHaveLength(1);
    const none = new Backlog({ store: new PgBacklogStore(db), pipeline: { createTask: (i) => pipeline.createTask(i) }, staleDays: 14 });
    expect((await none.list()).find((e) => e.id === a.body.id)!.schedulable).toBe(false);
  });

  it("promote refuses an item that is not schedulable with 409 not_schedulable and the ids, and removes nothing", async () => {
    const first = await add("First");
    const second = await add("Second", { dependsOn: [first.body.id] });
    const refused = await call("POST", `/backlog/${second.body.id}/promote`);
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ error: "not_schedulable", blockedBy: [{ id: first.body.id }] });
    expect(JSON.stringify(refused.body)).toContain(first.body.id);
    expect((await call("GET", "/backlog")).body).toHaveLength(2);
    expect(await pipeline.list()).toHaveLength(0);
  });

  it("promoting the item another item named makes that item name the new card, and the card keeps its own card dependencies", async () => {
    const done = await card("closed");
    const first = await add("First", { dependsOn: [done.id] });
    const second = await add("Second", { dependsOn: [first.body.id] });
    const promoted = await call("POST", `/backlog/${first.body.id}/promote`);
    expect(promoted.status).toBe(201);
    expect(cardOf(await pipeline.get(promoted.body.id)).dependsOn).toEqual([done.id]);
    const left = (await call("GET", "/backlog")).body;
    expect(left).toHaveLength(1);
    expect(left[0]).toMatchObject({ id: second.body.id, dependsOn: [promoted.body.id] });
    // The new card is a draft nobody has started: the second item waits for it.
    expect(left[0]).toMatchObject({ schedulable: false, blockedBy: [{ id: promoted.body.id, kind: "card", state: "draft" }] });
  });
});
