// The API's own description: GET /openapi.json (OpenAPI 3.1, built from every route's schemas) and GET /docs
// (Swagger UI on it). Both are read without the token; every other route keeps the door it had. Every route the
// app serves is in the document, so the description cannot drift from the API.
import type { DataSource } from "typeorm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { previewOn } from "../../test/policies.ts";

import { Pipeline } from "../../application/pipeline.ts";
import { StubStages } from "../../application/stages/stubs.ts";
import { freshTestDatabase } from "../../test/database.ts";
import { type ApiAccess, createApp } from "./app.ts";
import { Bus } from "./bus.ts";

let db: DataSource;
let pipeline: Pipeline;

beforeAll(async () => {
  db = await freshTestDatabase();
  pipeline = new Pipeline(db, new StubStages().runnerFor, { inline: true, policies: previewOn, hasConfig: () => true });
});
afterAll(async () => {
  await db.destroy();
});

const locked: ApiAccess = { host: "127.0.0.1", port: 4317, token: "s3cret" };
const unused = {} as never;
/** Every optional area switched on, so every route is mounted. The handlers never run here: only the routes are read. */
const everything = (access: ApiAccess = locked) =>
  createApp({
    db, pipeline, bus: new Bus(), access,
    repoHealth: async () => [], approveBase: async () => ({ ok: true }), economy: unused, backlog: unused, tickets: unused, compliance: unused,
    stubs: new StubStages(), pulls: unused, prTasks: unused, taskDiff: unused, slack: unused, jira: unused, mcp: unused, runs: unused, configProofs: unused,
  });

interface OpenApiDocument {
  openapi: string;
  info: { title: string };
  paths: Record<string, Record<string, { tags?: string[]; summary?: string; responses: Record<string, unknown> }>>;
  components?: { securitySchemes?: Record<string, { type: string; scheme?: string }> };
  security?: Array<Record<string, string[]>>;
}

const documentOf = async (app = everything()): Promise<OpenApiDocument> => {
  const response = await app.request("/openapi.json");
  expect(response.status).toBe(200);
  return (await response.json()) as OpenApiDocument;
};

describe("GET /openapi.json", () => {
  it("is an OpenAPI 3.1 document, read without the token, that asks for the bearer token on every route", async () => {
    const doc = await documentOf();
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.info.title).toMatch(/Luna/);
    expect(doc.components?.securitySchemes?.bearerAuth).toMatchObject({ type: "http", scheme: "bearer" });
    expect(doc.security).toEqual([{ bearerAuth: [] }]);
  });

  it("describes every route the app serves, with a tag, a summary and a response schema for each status", async () => {
    const app = everything();
    const doc = await documentOf(app);
    const served = app.routes
      .filter((route) => route.method !== "ALL" && !["/openapi.json", "/docs"].includes(route.path))
      .map((route) => `${route.method.toLowerCase()} ${route.path.replace(/:(\w+)/g, "{$1}")}`);
    const documented = Object.entries(doc.paths).flatMap(([path, methods]) => Object.keys(methods).map((method) => `${method} ${path}`));
    expect([...new Set(served)].filter((route) => !documented.includes(route)).sort()).toEqual([]);
    for (const [path, methods] of Object.entries(doc.paths)) {
      for (const [method, op] of Object.entries(methods)) {
        expect(op.tags?.length, `${method} ${path} tags`).toBeGreaterThan(0);
        expect(op.summary, `${method} ${path} summary`).toBeTruthy();
        for (const [status, response] of Object.entries(op.responses)) {
          if (status === "204") continue;
          expect((response as { content?: unknown }).content, `${method} ${path} ${status} content`).toBeDefined();
        }
      }
    }
  });
});

describe("what a client generator reads", () => {
  it("gives every operation a unique operationId, the name a generated client calls it by", async () => {
    const doc = await documentOf();
    const ids = Object.entries(doc.paths).flatMap(([path, methods]) => Object.entries(methods).map(([method, op]) => ({ at: `${method} ${path}`, id: (op as { operationId?: string }).operationId })));
    expect(ids.filter((op) => !op.id).map((op) => op.at)).toEqual([]);
    const seen = new Map<string, string>();
    const duplicated = ids.filter((op) => (seen.has(op.id!) ? true : (seen.set(op.id!, op.at), false))).map((op) => `${op.id}: ${op.at} and ${seen.get(op.id!)}`);
    expect(duplicated).toEqual([]);
    for (const op of ids) expect(op.id, op.at).toMatch(/^[a-z][A-Za-z]+$/);
  });
});

describe("GET /docs", () => {
  it("is Swagger UI on /openapi.json, read without the token", async () => {
    const response = await everything().request("/docs");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/text\/html/);
    const html = await response.text();
    expect(html).toMatch(/swagger-ui/i);
    expect(html).toContain("/openapi.json");
  });
});

describe("the door with the docs open", () => {
  it("still asks every other route for the token", async () => {
    expect((await everything().request("/health")).status).toBe(401);
    expect((await everything().request("/tasks")).status).toBe(401);
    expect((await everything().request("/health", { headers: { authorization: "Bearer s3cret" } })).status).toBe(200);
  });

  it("lets the docs page call the API from the port Docker publishes it on, with the token, and still refuses any other page", async () => {
    const published = everything({ ...locked, host: "0.0.0.0", publicPort: 4318 });
    const fromDocs = await published.request("/health", { headers: { origin: "http://127.0.0.1:4318", authorization: "Bearer s3cret" } });
    expect(fromDocs.status).toBe(200);
    const elsewhere = await published.request("/health", { headers: { origin: "https://evil.example", authorization: "Bearer s3cret" } });
    expect(elsewhere.status).toBe(403);
    const noToken = await published.request("/health", { headers: { origin: "http://127.0.0.1:4318" } });
    expect(noToken.status).toBe(401);
  });
});

describe("a route's schema at the door", () => {
  const auth = { authorization: "Bearer s3cret", "content-type": "application/json" };
  it("answers a body that breaks the route's schema with the machine's own 400 invalid_request, not the library's", async () => {
    const response = await everything().request("/slots", { method: "PATCH", headers: auth, body: JSON.stringify({ max: 0 }) });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_request", message: expect.stringContaining("max") });
  });

  it("answers a body that is not JSON, or no body, with 400 invalid_request", async () => {
    const broken = await everything().request("/slots", { method: "PATCH", headers: auth, body: "{" });
    expect(broken.status).toBe(400);
    expect(await broken.json()).toMatchObject({ error: "invalid_request" });
    const none = await everything().request("/slots", { method: "PATCH", headers: { authorization: "Bearer s3cret" } });
    expect(none.status).toBe(400);
    expect(await none.json()).toMatchObject({ error: "invalid_request" });
  });
});

describe("the conformance check the tests run (openapi/conformance.ts)", () => {
  it("bites: reports a body that breaks its schema, a status the route does not document, and an undocumented content type; passes a good answer", async () => {
    const { createRoute, z } = await import("@hono/zod-openapi");
    const { createOpenApiRouter } = await import("./openapi/router.ts");
    const { responseConformance } = await import("./openapi/conformance.ts");
    const { jsonContent } = await import("./openapi/schemas.ts");
    const found: Array<{ route: string; status: number; problem: string }> = [];
    const probe = createOpenApiRouter();
    probe.use(responseConformance(probe, (violation) => found.push(violation)));
    const route = createRoute({ method: "get", path: "/probe/{mode}", operationId: "probe", tags: ["Probe"], summary: "probe", request: { params: z.object({ mode: z.string() }) }, responses: { 200: jsonContent(z.object({ n: z.number() }), "ok") } });
    // Untyped on purpose: the handler answers what the route does not say, which the type checker would refuse.
    probe.openapi(route, ((c: { req: { param: (k: string) => string }; json: (b: unknown, s: number) => Response; text: (b: string) => Response }) => {
      const mode = c.req.param("mode");
      if (mode === "good") return c.json({ n: 1 }, 200);
      if (mode === "body") return c.json({ n: "one" }, 200);
      if (mode === "status") return c.json({ n: 1 }, 418);
      return c.text("plain");
    }) as never);
    for (const mode of ["good", "body", "status", "type"]) await probe.request(`/probe/${mode}`);
    expect(found.map((v) => [v.status, v.problem.split(" ")[0]])).toEqual([
      [200, "✖"],
      [418, "status"],
      [200, "content"],
    ]);
    expect(found.every((v) => v.route === "GET /probe/{mode}")).toBe(true);
  });
});
