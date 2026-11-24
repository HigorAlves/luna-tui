// Who may call the API: only a client that says it sends JSON, from no foreign web page, to the
// machine's own loopback address, carrying the token when one is set. A web page cannot drive it.
import type { DataSource } from "typeorm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { previewOn } from "../../test/policies.ts";

import { Pipeline } from "../../application/pipeline.ts";
import { StubStages } from "../../application/stages/stubs.ts";
import { freshTestDatabase } from "../../test/database.ts";
import { type ApiAccess, createApp } from "./app.ts";
import { Bus } from "./bus.ts";

let db: DataSource;
const stubs = new StubStages();
let pipeline: Pipeline;

beforeAll(async () => {
  db = await freshTestDatabase();
});
afterAll(async () => {
  await db.destroy();
});
beforeEach(async () => {
  await db.query("truncate tasks cascade");
  stubs.reset();
  pipeline = new Pipeline(db, stubs.runnerFor, { inline: true, policies: previewOn, hasConfig: () => true });
});

const loopback: ApiAccess = { host: "127.0.0.1", port: 4317, token: null };
const app = (access: ApiAccess = loopback) => createApp({ db, pipeline, bus: new Bus(), access });
const order = JSON.stringify({ title: "Login page", start: true });
const json = { "content-type": "application/json" };

describe("the API's door", () => {
  it("refuses a body that is not declared JSON (415), so a cross-site form or no-cors fetch makes no task", async () => {
    const plain = await app().request("/tasks", { method: "POST", body: order, headers: { "content-type": "text/plain;charset=UTF-8" } });
    expect(plain.status).toBe(415);
    expect(await plain.json()).toMatchObject({ error: "unsupported_media_type" });
    const form = await app().request("/tasks", { method: "POST", body: "title=x", headers: { "content-type": "application/x-www-form-urlencoded" } });
    expect(form.status).toBe(415);
    const undeclared = await app().request("/tasks", { method: "POST", body: new Blob([order]), headers: { "content-length": String(order.length) } });
    expect(undeclared.status).toBe(415);
    expect(await pipeline.list()).toHaveLength(0);
  });

  it("refuses a PR merge from a web page too: the rule is on every route", async () => {
    const merge = await app().request("/github/prs/a/b/1/merge", { method: "POST", body: "{}", headers: { "content-type": "text/plain" } });
    expect(merge.status).toBe(415);
  });

  it("takes JSON with or without a charset, and a bodyless command, from a client that sends no Origin", async () => {
    expect((await app().request("/tasks", { method: "POST", body: order, headers: json })).status).toBe(201);
    const charset = await app().request("/tasks", { method: "POST", body: JSON.stringify({ title: "b" }), headers: { "content-type": "application/json; charset=utf-8", host: "127.0.0.1:4317" } });
    expect(charset.status).toBe(201);
    expect((await app().request("/drain", { method: "POST" })).status).toBe(200);
    expect((await app().request("/tasks", { headers: { host: "localhost:4317" } })).status).toBe(200);
    expect((await app().request("/health", { headers: { host: "[::1]:4317" } })).status).toBe(200);
  });

  it("refuses a request a web page sent (403 forbidden_origin), reads and the event stream included", async () => {
    for (const [method, path] of [["POST", "/tasks"], ["GET", "/tasks"], ["GET", "/events"], ["GET", "/health"]] as const) {
      const response = await app().request(path, { method, ...(method === "POST" ? { body: order } : {}), headers: { ...json, origin: "https://evil.example" } });
      expect(response.status, `${method} ${path}`).toBe(403);
      expect(await response.json()).toMatchObject({ error: "forbidden_origin" });
    }
    expect((await app().request("/tasks", { headers: { origin: "null" } })).status).toBe(403);
    expect((await app().request("/tasks", { headers: { origin: "http://127.0.0.1:9999" } })).status).toBe(403);
    expect(await pipeline.list()).toHaveLength(0);
  });

  it("lets the machine's own origin through", async () => {
    expect((await app().request("/tasks", { headers: { origin: "http://127.0.0.1:4317" } })).status).toBe(200);
    expect((await app().request("/tasks", { headers: { origin: "http://localhost:4317" } })).status).toBe(200);
  });

  it("refuses a rebound host name (403 forbidden_host) while it binds to loopback", async () => {
    const rebound = await app().request("/tasks", { method: "POST", body: order, headers: { ...json, host: "evil.example:4317" } });
    expect(rebound.status).toBe(403);
    expect(await rebound.json()).toMatchObject({ error: "forbidden_host" });
    expect((await app().request("/tasks", { headers: { host: "127.0.0.1:4318" } })).status).toBe(403);
    expect((await app().request("/tasks", { headers: { host: "127.0.0.1" } })).status).toBe(403);
    expect(await pipeline.list()).toHaveLength(0);
  });

  it("skips the host check when it binds beyond loopback, where the token guards it", async () => {
    const wide = app({ host: "0.0.0.0", port: 4317, token: "s3cret" });
    const response = await wide.request("/tasks", { headers: { host: "127.0.0.1:4318", authorization: "Bearer s3cret" } });
    expect(response.status).toBe(200);
  });

  it("asks for the bearer token when one is set (401), and takes the right one", async () => {
    const guarded = app({ ...loopback, token: "s3cret" });
    const none = await guarded.request("/tasks");
    expect(none.status).toBe(401);
    expect(await none.json()).toMatchObject({ error: "unauthorized" });
    expect((await guarded.request("/tasks", { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
    expect((await guarded.request("/tasks", { headers: { authorization: "Bearer s3cret-and-more" } })).status).toBe(401);
    expect((await guarded.request("/tasks", { headers: { authorization: "s3cret" } })).status).toBe(401);
    expect((await guarded.request("/events", { headers: { authorization: "Basic s3cret" } })).status).toBe(401);
    const created = await guarded.request("/tasks", { method: "POST", body: order, headers: { ...json, authorization: "Bearer s3cret" } });
    expect(created.status).toBe(201);
    expect((await guarded.request("/tasks", { headers: { authorization: "bearer s3cret" } })).status).toBe(200);
  });
});
