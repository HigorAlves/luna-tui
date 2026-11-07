import type { DataSource } from "typeorm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { noMemory } from "../../application/memory.ts";
import { MemoryService } from "../../application/memory-service.ts";
import { Pipeline } from "../../application/pipeline.ts";
import { StubStages } from "../../application/stages/stubs.ts";
import { freshTestDatabase } from "../../test/database.ts";
import { previewOn } from "../../test/policies.ts";
import { fakeMemory } from "../../test/memory.ts";
import { createApp } from "./app.ts";
import { Bus } from "./bus.ts";

let db: DataSource;
beforeAll(async () => {
  db = await freshTestDatabase();
});
afterAll(async () => {
  await db.destroy();
});

const draft = (text: string, over: Record<string, unknown> = {}) => ({
  kind: "outcome" as const,
  repo: "api-1",
  source: { kind: "github" as const, ref: null },
  anchors: { files: ["src/a.ts"], commit: "abc" },
  provenance: { by: "machine" as const, card: "c1", run: null, pack: null },
  trust: "fact" as const,
  text,
  ...over,
});

async function appWith(options: { off?: boolean; agents?: boolean; unwired?: boolean } = {}) {
  const memory = options.off ? noMemory() : fakeMemory();
  const [a] = await memory.write([draft("the uploader retries three times"), draft("outside note about the uploader", { trust: "outside" as never })]);
  const forgotten: unknown[] = [];
  const service = new MemoryService({
    memory,
    slugOf: (p) => p,
    ...(options.agents === false ? {} : { run: async (c) => ({ answer: "Three.", citations: [c.items[0]!.id], grounded: true }) }),
    onForgotten: async (r) => void forgotten.push(r),
  });
  const pipeline = new Pipeline(db, new StubStages().runnerFor, { inline: true, policies: previewOn, hasConfig: () => true });
  const app = createApp({ db, pipeline, bus: new Bus(), ...(options.unwired ? {} : { memory: service }) });
  return { app, memory, a: a?.id ?? "", forgotten };
}

const post = (app: Awaited<ReturnType<typeof appWith>>["app"], path: string, body: unknown = {}) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("/memory routes", () => {
  it("POST /memory/ask answers through the pack with citations; ?via=cognee takes the same shape", async () => {
    const { app } = await appWith();
    const pack = await post(app, "/memory/ask", { question: "how often does the uploader retry?" });
    expect(pack.status).toBe(200);
    expect(await pack.json()).toMatchObject({ via: "pack", answer: "Three.", grounded: true, citations: [{ kind: "item", ref: expect.any(String) }] });
    const cognee = await post(app, "/memory/ask?via=cognee", { question: "how often does the uploader retry?" });
    expect(await cognee.json()).toMatchObject({ via: "cognee", citations: [{ kind: "item" }], grounded: true });
    expect((await post(app, "/memory/ask?via=other", { question: "x" })).status).toBe(400);
    expect((await post(app, "/memory/ask", { question: "" })).status).toBe(400);
  });

  it("POST /memory/ask without agents is a clear 503, and ?via=cognee still answers", async () => {
    const { app } = await appWith({ agents: false });
    const out = await post(app, "/memory/ask", { question: "how often does the uploader retry?" });
    expect(out.status).toBe(503);
    expect(await out.json()).toMatchObject({ error: "agents_off" });
    expect((await post(app, "/memory/ask?via=cognee", { question: "how often does the uploader retry?" })).status).toBe(200);
  });

  it("POST /memory/recall returns items, never an answer, and not the outside ones", async () => {
    const { app } = await appWith();
    const out = await post(app, "/memory/recall", { query: "uploader", scope: "all" });
    expect(out.status).toBe(200);
    const json = (await out.json()) as { items: Array<{ text: string }>; note: string | null };
    expect(json.items.map((i) => i.text)).toEqual(["the uploader retries three times"]);
    expect(json).not.toHaveProperty("answer");
  });

  it("GET /memory/items filters by repo, status, trust and kind and pages; GET /memory/items/:id reads one", async () => {
    const { app, a } = await appWith();
    const all = (await (await app.request("/memory/items?repo=api-1")).json()) as Array<{ id: string; trust: string }>;
    expect(all).toHaveLength(2);
    const outside = (await (await app.request("/memory/items?trust=outside")).json()) as Array<{ id: string }>;
    expect(outside).toHaveLength(1);
    expect(await (await app.request("/memory/items?status=retired")).json()).toEqual([]);
    expect(await (await app.request("/memory/items?limit=1&offset=1")).json()).toHaveLength(1);
    expect((await app.request("/memory/items?status=gone")).status).toBe(400);
    expect(await (await app.request(`/memory/items/${a}`)).json()).toMatchObject({ id: a, kind: "outcome" });
    expect((await app.request("/memory/items/mem_9999")).status).toBe(404);
  });

  it("POST /memory/items/:id/forget retires the item and records ground truth; adopt turns an outside item into a lesson", async () => {
    const { app, a, forgotten } = await appWith();
    const out = await post(app, `/memory/items/${a}/forget`, { reason: "wrong" });
    expect(out.status).toBe(200);
    expect(await out.json()).toMatchObject({ id: a, status: "retired" });
    expect(forgotten).toEqual([expect.objectContaining({ id: a, reason: "wrong", by: "api" })]);
    expect((await post(app, "/memory/items/mem_9999/forget")).status).toBe(404);
    const outside = ((await (await app.request("/memory/items?trust=outside")).json()) as Array<{ id: string }>)[0]!.id;
    expect(await (await post(app, `/memory/items/${outside}/adopt`)).json()).toMatchObject({ trust: "lesson" });
    expect((await post(app, `/memory/items/${a}/adopt`)).status).toBe(404);
  });

  it("GET /memory/status says mode and usage", async () => {
    const { app } = await appWith();
    expect(await (await app.request("/memory/status")).json()).toEqual({ enabled: true, mode: "openai", tokensToday: null, costUsdToday: null, cognifiedToday: 0 });
  });

  it("answers 503 memory_off on every route when memory is off or not wired", async () => {
    for (const options of [{ off: true }, { unwired: true }]) {
      const { app } = await appWith(options);
      for (const [method, path] of [["POST", "/memory/ask"], ["POST", "/memory/recall"], ["GET", "/memory/items"], ["GET", "/memory/items/x"], ["POST", "/memory/items/x/forget"], ["POST", "/memory/items/x/adopt"]] as const) {
        const out = await app.request(path, { method, headers: { "content-type": "application/json" }, ...(method === "POST" ? { body: JSON.stringify({ question: "q", query: "q" }) } : {}) });
        expect(out.status, `${method} ${path}`).toBe(503);
        expect(await out.json()).toMatchObject({ error: "memory_off" });
      }
    }
    expect(await (await (await appWith({ off: true })).app.request("/memory/status")).json()).toMatchObject({ enabled: false, mode: null });
  });
});
