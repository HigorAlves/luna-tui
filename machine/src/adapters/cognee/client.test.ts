// The Cognee client against a fake HTTP server that answers with the shapes the M0 spike recorded (RFC 0007, "Implementation notes").
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CogneeError, cogneeClient } from "./client.ts";

interface Seen {
  method: string;
  url: string;
  auth: string | undefined;
  type: string | undefined;
  body: string;
}

let server: Server;
let base = "";
let seen: Seen[] = [];
let handler: (req: Seen, res: ServerResponse) => void = (_req, res) => res.writeHead(404).end();

const bodyOf = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve) => {
    const parts: Buffer[] = [];
    req.on("data", (c: Buffer) => parts.push(c));
    req.on("end", () => resolve(Buffer.concat(parts).toString("utf8")));
  });

beforeEach(async () => {
  seen = [];
  server = createServer(async (req, res) => {
    const entry: Seen = { method: req.method ?? "", url: req.url ?? "", auth: req.headers.authorization, type: req.headers["content-type"], body: await bodyOf(req) };
    seen.push(entry);
    handler(entry, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const send = (res: ServerResponse, status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
const client = (extra: Partial<Parameters<typeof cogneeClient>[0]> = {}) => cogneeClient({ baseUrl: base, email: "machine@luna.example.com", password: "s3cret-password", ...extra });

/** A server that logs in and hands out tokens `tok-1`, `tok-2`, ..., then lets a route function answer. */
function authed(route: (req: Seen, res: ServerResponse) => void): void {
  let issued = 0;
  handler = (req, res) => {
    if (req.url === "/api/v1/auth/register") return send(res, 201, { id: "u" });
    if (req.url === "/api/v1/auth/login") return send(res, 200, { access_token: `tok-${++issued}`, token_type: "bearer" });
    route(req, res);
  };
}

describe("connect", () => {
  it("registers the machine user, then logs in with a form", async () => {
    authed((_req, res) => send(res, 200, []));
    await client().connect();
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual(["POST /api/v1/auth/register", "POST /api/v1/auth/login"]);
    expect(JSON.parse(seen[0]!.body)).toEqual({ email: "machine@luna.example.com", password: "s3cret-password" });
    expect(seen[1]!.type).toContain("application/x-www-form-urlencoded");
    expect(new URLSearchParams(seen[1]!.body).get("username")).toBe("machine@luna.example.com");
  });

  it("takes an existing user as fine and refuses any other registration failure, never repeating the password", async () => {
    handler = (req, res) => (req.url === "/api/v1/auth/register" ? send(res, 400, { detail: "REGISTER_USER_ALREADY_EXISTS" }) : send(res, 200, { access_token: "t" }));
    await expect(client().connect()).resolves.toBeUndefined();
    handler = (_req, res) => send(res, 400, { detail: { code: "REGISTER_INVALID_PASSWORD", reason: "bad s3cret-password" } });
    const error = await client().connect().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CogneeError);
    expect((error as Error).message).not.toContain("s3cret-password");
    expect((error as CogneeError).status).toBe(400);
  });

  it("says a refused login without the token or the password", async () => {
    handler = (req, res) => (req.url === "/api/v1/auth/register" ? send(res, 201, {}) : send(res, 400, { detail: "LOGIN_BAD_CREDENTIALS s3cret-password" }));
    const error = (await client().connect().catch((e: unknown) => e)) as CogneeError;
    expect(error.message).toMatch(/login failed \(400\)/);
    expect(error.message).not.toContain("s3cret-password");
  });
});

describe("calls", () => {
  it("logs in again after a 401 and repeats the call once", async () => {
    let calls = 0;
    authed((req, res) => {
      if (req.url === "/api/v1/datasets") return ++calls === 1 ? send(res, 401, { detail: "expired" }) : send(res, 200, [{ id: "d1", name: "r:github" }, { name: "no-id" }]);
    });
    const c = client();
    expect(await c.datasets()).toEqual([{ id: "d1", name: "r:github" }]);
    const auths = seen.filter((s) => s.url === "/api/v1/datasets").map((s) => s.auth);
    expect(auths).toEqual(["Bearer tok-1", "Bearer tok-2"]);
  });

  it("times out a slow call with a CogneeError that says so", async () => {
    authed(() => {
      /* never answers */
    });
    const error = (await client({ timeoutMs: 80 }).datasets(80).catch((e: unknown) => e)) as CogneeError;
    expect(error).toBeInstanceOf(CogneeError);
    expect(error.timedOut).toBe(true);
  });

  it("adds items as one multipart request with a luna_id each, and returns the data ids in order", async () => {
    authed((req, res) => send(res, 200, { status: "PipelineRunCompleted", dataset_id: "ds-1", dataset_name: "r:github", data_ids: ["a", "b"], data_ingestion_info: [] }));
    const added = await client().add({ dataset: "r:github", items: [{ lunaId: "mem_1", text: "luna:mem_1\nfirst" }, { lunaId: "mem_2", text: "luna:mem_2\nsecond" }] });
    expect(added).toEqual({ datasetId: "ds-1", datasetName: "r:github", dataIds: ["a", "b"] });
    const add = seen.find((s) => s.url === "/api/v1/add")!;
    expect(add.type).toContain("multipart/form-data");
    expect(add.body).toContain('name="datasetName"');
    expect(add.body).toContain("r:github");
    expect(add.body.match(/name="raw_data"/g)).toHaveLength(2);
    expect(add.body).toContain('[{"luna_id":"mem_1"},{"luna_id":"mem_2"}]');
  });

  it("uploads a file as a data part", async () => {
    authed((_req, res) => send(res, 200, { dataset_id: "ds-1", dataset_name: "company", data_ids: ["f"] }));
    await client().add({ dataset: "company", items: [{ lunaId: "mem_9", file: { name: "handbook.md", content: Buffer.from("# Handbook"), type: "text/markdown" } }] });
    const add = seen.find((s) => s.url === "/api/v1/add")!;
    expect(add.body).toContain('name="data"; filename="handbook.md"');
    expect(add.body).toContain("# Handbook");
  });

  it("refuses an add that answers a different number of data ids than items", async () => {
    authed((_req, res) => send(res, 200, { dataset_id: "ds-1", dataset_name: "x", data_ids: [] }));
    await expect(client().add({ dataset: "x", items: [{ lunaId: "m", text: "t" }] })).rejects.toThrow(/0 data ids for 1 items/);
  });

  it("cognifies the named datasets in chunks the local embedder can hold, and fails on a pipeline that ended in error", async () => {
    let status = "PipelineRunCompleted";
    authed((_req, res) => send(res, 200, { "ds-1": { status } }));
    await client().cognify(["r:github"]);
    // Cognee sizes chunks to an 8191-token embedding limit unless told: the local embedder holds 512, and GLiNER on chunks that big ran Cognee out of memory.
    expect(JSON.parse(seen.find((s) => s.url === "/api/v1/cognify")!.body)).toEqual({ datasets: ["r:github"], runInBackground: false, chunkSize: 512 });
    status = "PipelineRunErrored";
    await expect(client().cognify(["r:github"])).rejects.toThrow(/cognify ended/);
  });

  it("searches CHUNKS with no model call, turns the distance into a score, and reads the luna_id and data id of each hit", async () => {
    authed((_req, res) =>
      send(res, 200, [
        { dataset_id: "ds-1", dataset_name: "r:github", objects_result: [{ score: 0.2, payload: { text: "luna:a1 flaky", document_id: "data-1", external_metadata: '{"luna_id": "a1"}' } }, { score: 0.5, payload: { text: "outside chunk", document_id: "data-9", external_metadata: null } }, { score: 0.1, payload: {} }] },
        { dataset_id: "ds-2", dataset_name: "r:docs", error: "no graph yet" },
      ]),
    );
    const entries = await client().chunks({ datasets: ["r:github", "r:docs"], query: "flaky", topK: 6 });
    const search = JSON.parse(seen.find((s) => s.url === "/api/v1/search")!.body);
    expect(search).toMatchObject({ searchType: "CHUNKS", onlyContext: true, verbose: true, datasets: ["r:github", "r:docs"], topK: 6, query: "flaky" });
    expect(entries).toHaveLength(2);
    expect(entries[0]!.hits).toEqual([
      { score: expect.closeTo(0.8, 5), text: "luna:a1 flaky", dataId: "data-1", lunaId: "a1" },
      { score: expect.closeTo(0.5, 5), text: "outside chunk", dataId: "data-9", lunaId: null },
    ]);
    expect(entries[1]).toMatchObject({ datasetName: "r:docs", error: "no graph yet", hits: [] });
  });

  it("reads a code graph through SearchType.CODE with the operation and its arguments", async () => {
    authed((_req, res) => send(res, 200, [{ dataset_name: "code:app", search_result: [{ symbol: "main" }] }]));
    const result = await client().code({ dataset: "code:app", operation: "neighbors", args: { symbol: "main" } });
    expect(JSON.parse(seen.find((s) => s.url === "/api/v1/search")!.body)).toMatchObject({ searchType: "CODE", datasets: ["code:app"], codeQuery: { operation: "neighbors", symbol: "main" } });
    expect(result).toEqual([{ datasetName: "code:app", error: null, results: [{ symbol: "main" }] }]);
  });

  it("lists a dataset's data with each item's luna_id, paging", async () => {
    authed((req, res) => send(res, 200, [{ id: "i1", name: "text_x", externalMetadata: { luna_id: "m1" }, contentHash: "abc" }, { id: "i2", name: "uploaded.pdf", externalMetadata: null }]));
    expect(await client().data("ds-1")).toEqual([
      { id: "i1", name: "text_x", lunaId: "m1", contentHash: "abc" },
      { id: "i2", name: "uploaded.pdf", lunaId: null, contentHash: null },
    ]);
    expect(seen.find((s) => s.url.startsWith("/api/v1/datasets/ds-1/data"))!.url).toContain("limit=500&offset=0");
  });

  it("deletes a data item, and takes an item already gone as deleted", async () => {
    let status = 200;
    authed((_req, res) => send(res, status, { status: "success" }));
    await client().deleteData("ds-1", "i1");
    status = 404;
    await expect(client().deleteData("ds-1", "i1")).resolves.toBeUndefined();
    status = 500;
    await expect(client().deleteData("ds-1", "i1")).rejects.toThrow(/answered 500/);
    expect(seen.filter((s) => s.method === "DELETE").every((s) => s.url === "/api/v1/datasets/ds-1/data/i1")).toBe(true);
  });

  it("answers with GRAPH_COMPLETION text, and null cost when Cognee has none", async () => {
    authed((req, res) => (req.url.startsWith("/api/v1/sessions") ? send(res, 500, {}) : send(res, 200, [{ search_result: ["The answer."] }, { search_result: "More." }])));
    const c = client();
    expect(await c.complete({ datasets: ["a"], query: "q" })).toBe("The answer.\n\nMore.");
    expect(await c.cost()).toBeNull();
  });

  it("reports health without a token and false when nothing listens", async () => {
    handler = (_req, res) => send(res, 200, { status: "ready" });
    expect(await client().health()).toBe(true);
    expect(seen[0]!.auth).toBeUndefined();
    expect(await cogneeClient({ baseUrl: "http://127.0.0.1:1", email: "a@b.example.com", password: "pppp" }).health(300)).toBe(false);
  });
});
