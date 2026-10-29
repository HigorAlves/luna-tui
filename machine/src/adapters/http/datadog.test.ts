import type { DatadogItem, DatadogSnapshot, DatadogTriageRun } from "@hardness/contracts";
import type { DataSource } from "typeorm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { AlreadyTaskError, type DatadogInboxPort, NoDatadogItemError } from "../../application/datadog-inbox.ts";
import { Pipeline } from "../../application/pipeline.ts";
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

const item = (id: string, over: Partial<DatadogItem> = {}): DatadogItem => ({
  id,
  source: "error_tracking",
  title: "TypeError: x is undefined",
  service: "web",
  env: "prod",
  status: "OPEN",
  severity: null,
  count: 12,
  firstSeen: "2026-10-28T10:00:00Z",
  lastSeen: "2026-10-28T11:55:00Z",
  url: "https://app.datadoghq.com/error-tracking/issue/9f3",
  samples: ["x is undefined"],
  repository: null,
  floor: null,
  triage: null,
  split: "investigate",
  snoozedUntil: null,
  doneAt: null,
  reopenedAt: null,
  resolvedAt: null,
  taskId: null,
  ...over,
});

/** A fake inbox: a fixed snapshot, and a log of what the routes asked it to do. */
function fakeInbox(items: DatadogItem[]): DatadogInboxPort & { did: string[] } {
  const ok = { ok: true, error: null, count: 0 };
  const snapshot: DatadogSnapshot = { items, polledAt: "2026-10-28T12:00:00Z", sources: { incident: ok, monitor: ok, error_tracking: { ...ok, count: items.length }, error_logs: ok }, triaging: false, error: null };
  const did: string[] = [];
  const find = (id: string) => {
    const found = items.find((i) => i.id === id);
    if (!found) throw new NoDatadogItemError(id);
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
    async toTask(id, input) {
      const found = find(id);
      if (found.taskId) throw new AlreadyTaskError(id, found.taskId);
      did.push(`task ${id} ${JSON.stringify(input)}`);
      return pipeline.createTask({ title: input.title ?? found.title, source: { kind: "datadog", source: found.source, id: found.id, url: found.url } });
    },
    async triageRuns(since) {
      did.push(`triage-runs ${since.toISOString()}`);
      return [{ id: "r1", startedAt: "2026-10-28T11:00:00Z", endedAt: "2026-10-28T11:00:20Z", items: 3, model: "claude-haiku-5-5", turns: 1, costUsd: 0.0042, ok: true, error: null }] satisfies DatadogTriageRun[];
    },
  };
}

const json = (method: string, body: unknown) => ({ method, body: JSON.stringify(body), headers: { "content-type": "application/json" } });

describe("the Datadog inbox over HTTP", () => {
  it("serves the snapshot and polls on demand", async () => {
    const datadog = fakeInbox([item("et:9f3")]);
    const app = createApp({ db, pipeline, bus: new Bus(), datadog });
    const got = await app.request("/datadog/items");
    expect(got.status).toBe(200);
    expect(await got.json()).toMatchObject({ items: [{ id: "et:9f3", split: "investigate" }], triaging: false, error: null });
    expect((await app.request("/datadog/refresh", { method: "POST" })).status).toBe(200);
    expect(datadog.did).toEqual(["poll"]);
  });

  it("is absent without an inbox", async () => {
    const app = createApp({ db, pipeline, bus: new Bus() });
    expect((await app.request("/datadog/items")).status).toBe(404);
  });

  it("patches an item, 404 no_item for an unknown one, 400 for a bad body", async () => {
    const datadog = fakeInbox([item("et:9f3")]);
    const app = createApp({ db, pipeline, bus: new Bus(), datadog });
    const done = await app.request("/datadog/items/et:9f3", json("PATCH", { done: true }));
    expect(done.status).toBe(200);
    expect(await done.json()).toMatchObject({ split: "done" });
    const missing = await app.request("/datadog/items/et:nope", json("PATCH", { done: true }));
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: "no_item" });
    expect((await app.request("/datadog/items/et:9f3", json("PATCH", { priority: "P9" }))).status).toBe(400);
    expect(datadog.did).toEqual(['patch et:9f3 {"done":true}']);
  });

  it("makes a task from an item (201) once (409 already_task)", async () => {
    const datadog = fakeInbox([item("et:9f3"), item("et:2", { taskId: "t1" })]);
    const app = createApp({ db, pipeline, bus: new Bus(), datadog });
    const created = await app.request("/datadog/items/et%3A9f3/task", json("POST", { title: "Fix it" }));
    expect(created.status).toBe(201);
    expect((await created.json()) as TaskRow).toMatchObject({ title: "Fix it", state: "draft", source: { kind: "datadog", source: "error_tracking", id: "et:9f3" } });
    const again = await app.request("/datadog/items/et:2/task", json("POST", {}));
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: "already_task" });
  });

  it("lists the triage runs since a window, 400 for a bad one", async () => {
    const datadog = fakeInbox([]);
    const app = createApp({ db, pipeline, bus: new Bus(), datadog });
    const got = await app.request("/datadog/triage-runs?since=7d");
    expect(got.status).toBe(200);
    expect(await got.json()).toMatchObject([{ id: "r1", items: 3, costUsd: 0.0042 }]);
    expect(datadog.did[0]).toMatch(/^triage-runs 20\d\d-/);
    expect((await app.request("/datadog/triage-runs?since=soon")).status).toBe(400);
  });
});
