import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";

import { type Fetch, callRecall, findMachine, handle, readToken, serve } from "./memory-server.ts";

let server: Server | null = null;
afterEach(async () => {
  await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
  server = null;
});

const fetcher = fetch as unknown as Fetch;

/** A fake machine: records each request and answers `reply`. */
async function machine(reply: (req: IncomingMessage, body: string, res: ServerResponse) => void) {
  const seen: Array<{ url: string; method: string; headers: IncomingMessage["headers"]; body: string }> = [];
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      seen.push({ url: req.url ?? "", method: req.method ?? "", headers: req.headers, body });
      reply(req, body, res);
    });
  });
  await new Promise<void>((done) => server!.listen(0, "127.0.0.1", done));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

const item = { id: "mem_0001", kind: "outcome", text: "the uploader retries three times", source: "github", anchors: { files: ["src/up.ts"], commit: "abc" }, stale: false, score: 2 };
const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

describe("recall tool", () => {
  it("posts the query to /memory/recall with the bearer token and returns the items as text, not an answer", async () => {
    const m = await machine((_req, _body, res) => json(res, 200, { items: [item, { ...item, id: "mem_0002", stale: true, text: "older" }], note: null }));
    const out = await callRecall({ query: "uploader retries", repo: "api-1", scope: "all" }, async () => ({ url: m.url, token: "tok" }), fetcher);
    expect(m.seen).toHaveLength(1);
    expect(m.seen[0]).toMatchObject({ url: "/memory/recall", method: "POST" });
    expect(m.seen[0]!.headers.authorization).toBe("Bearer tok");
    expect(m.seen[0]!.headers["x-luna-client"]).toBe("mcp");
    expect(JSON.parse(m.seen[0]!.body)).toEqual({ query: "uploader retries", repo: "api-1", scope: "all" });
    expect(out.isError).toBeUndefined();
    expect(out.content[0]!.text).toContain("[mem_0001] outcome from github · files src/up.ts\nthe uploader retries three times");
    expect(out.content[0]!.text).toContain("[mem_0002] outcome from github (stale: its files changed a lot since)");
  });

  it("says plainly when nothing is recalled, and passes the note", async () => {
    const m = await machine((_req, _body, res) => json(res, 200, { items: [], note: "nothing matched" }));
    const out = await callRecall({ query: "zebra" }, async () => ({ url: m.url, token: null }), fetcher);
    expect(out.content[0]!.text).toBe("Nothing recalled: nothing matched");
    expect(m.seen[0]!.headers.authorization).toBeUndefined();
  });

  it("words memory off, a refused token and an unreachable machine as tool errors", async () => {
    const off = await machine((_req, _body, res) => json(res, 503, { error: "memory_off", message: "memory is off" }));
    expect((await callRecall({ query: "x" }, async () => ({ url: off.url, token: null }), fetcher)).content[0]!.text).toContain("Memory is off");
    await new Promise<void>((done) => server!.close(() => done()));
    server = null;
    const denied = await machine((_req, _body, res) => json(res, 401, { error: "unauthorized", message: "no" }));
    const refused = await callRecall({ query: "x" }, async () => ({ url: denied.url, token: "bad" }), fetcher);
    expect(refused).toMatchObject({ isError: true });
    expect(refused.content[0]!.text).toContain("refused the token");
    const down = await callRecall({ query: "x" }, async () => ({ url: "http://127.0.0.1:1", token: null }), fetcher);
    expect(down.isError).toBe(true);
    expect(down.content[0]!.text).toContain("not reachable");
  });

  it("rejects bad arguments without calling the machine", async () => {
    const m = await machine((_req, _body, res) => json(res, 200, { items: [] }));
    const machineOf = async () => ({ url: m.url, token: null });
    expect((await callRecall({ query: "  " }, machineOf, fetcher)).isError).toBe(true);
    expect((await callRecall({ query: "x", scope: "everything" }, machineOf, fetcher)).isError).toBe(true);
    expect((await callRecall({ query: "x", repo: 3 }, machineOf, fetcher)).isError).toBe(true);
    expect(m.seen).toHaveLength(0);
  });
});

describe("protocol", () => {
  const deps = { machine: async () => ({ url: "http://127.0.0.1:1", token: null }), fetcher };

  it("initializes, lists exactly one read-only tool, ignores notifications and refuses unknown tools and methods", async () => {
    expect(await handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } }, deps)).toMatchObject({ id: 1, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "luna-memory" } } });
    const list = (await handle({ jsonrpc: "2.0", id: 2, method: "tools/list" }, deps)) as { result: { tools: Array<{ name: string; inputSchema: { required: string[] } }> } };
    expect(list.result.tools.map((t) => t.name)).toEqual(["recall"]);
    expect(list.result.tools[0]!.inputSchema.required).toEqual(["query"]);
    expect(await handle({ jsonrpc: "2.0", method: "notifications/initialized" }, deps)).toBeNull();
    expect(await handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "forget", arguments: {} } }, deps)).toMatchObject({ error: { code: -32602 } });
    expect(await handle({ jsonrpc: "2.0", id: 4, method: "resources/list" }, deps)).toMatchObject({ error: { code: -32601 } });
  });

  it("serves newline-delimited JSON-RPC over streams, one reply line per request", async () => {
    const m = await machine((_req, _body, res) => json(res, 200, { items: [item], note: null }));
    const input = new PassThrough();
    const lines: string[] = [];
    const done = serve(input, (line) => lines.push(line), { machine: async () => ({ url: m.url, token: null }), fetcher });
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "recall", arguments: { query: "uploader" } } })}\n`);
    input.write("not json\n");
    input.end();
    await done;
    const replies = lines.map((l) => JSON.parse(l) as { id: number | null; result?: { content: Array<{ text: string }> }; error?: { code: number } });
    expect(replies.find((r) => r.id === 1)!.result!.content[0]!.text).toContain("[mem_0001]");
    expect(replies.find((r) => r.id === null)!.error!.code).toBe(-32700);
  });
});

describe("finding the machine and its token", () => {
  it("uses the pinned address alone, else the first machine that answers /health", async () => {
    expect(await findMachine(fetcher, { HARDNESS_MACHINE_URL: "http://example.test:9/" })).toBe("http://example.test:9");
    const seen: string[] = [];
    const fake: Fetch = async (url) => {
      seen.push(url);
      return { ok: url.startsWith("http://127.0.0.1:4318"), status: 200, json: async () => ({}), text: async () => "" };
    };
    expect(await findMachine(fake, {})).toBe("http://127.0.0.1:4318");
    expect(seen).toEqual(["http://127.0.0.1:4317/health", "http://127.0.0.1:4318/health"]);
    const none: Fetch = async () => Promise.reject(new Error("down"));
    expect(await findMachine(none, {})).toBe("http://127.0.0.1:4317");
  });

  it("reads MACHINE_API_TOKEN, else the token file, else nothing", () => {
    const home = mkdtempSync(join(tmpdir(), "mcp-home-"));
    expect(readToken({}, home)).toBeNull();
    mkdirSync(join(home, ".config", "hardness"), { recursive: true });
    writeFileSync(join(home, ".config", "hardness", "machine-api-token"), "from-file\n");
    expect(readToken({}, home)).toBe("from-file");
    expect(readToken({ MACHINE_API_TOKEN: " from env " }, home)).toBe("fromenv");
  });
});
