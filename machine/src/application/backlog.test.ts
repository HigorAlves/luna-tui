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

  it("decline removes the item; an unknown item is 404", async () => {
    const a = await add("Nope");
    expect((await call("POST", `/backlog/${a.body.id}/decline`)).status).toBe(200);
    expect((await call("GET", "/backlog")).body).toEqual([]);
    expect((await call("POST", `/backlog/${a.body.id}/decline`)).status).toBe(404);
    expect((await call("POST", "/backlog/not-a-uuid/bump")).status).toBe(404);
  });
});
