import { type IncomingHttpHeaders, type Server, createServer, request } from "node:http";
import { connect as netConnect } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { type EgressProxy, createEgressProxy, parseRelayMeta } from "./proxy.ts";

const REAL = "sk-ant-oat01-REAL-SECRET-VALUE";
const PLACEHOLDER = "sk-ant-oat01-luna-relay-abc123";
const PUBLIC = "93.184.216.34";

interface Seen {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingHttpHeaders;
  body: string;
}

let upstream: Server | undefined;
let proxy: EgressProxy | undefined;
afterEach(async () => {
  await proxy?.close();
  await new Promise<void>((resolve) => (upstream ? (upstream.closeAllConnections(), upstream.close(() => resolve())) : resolve()));
  proxy = undefined;
  upstream = undefined;
});

/** A relay for `kind` in front of a fake upstream (plain HTTP: the test stands in for api.anthropic.com). */
async function start(
  handler: Parameters<typeof createServer>[1],
  kind: "oauth" | "api-key" = "oauth",
  resolved: string[] = [PUBLIC],
  denyLocal: string[] = [],
  credential: () => Promise<string> = async () => REAL,
): Promise<{ port: number; seen: Seen[]; lines: string[]; connects: Array<{ port: number; address: string }>; lookups: string[] }> {
  const seen: Seen[] = [];
  const lines: string[] = [];
  const connects: Array<{ port: number; address: string }> = [];
  const lookups: string[] = [];
  upstream = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
      (handler as (req: unknown, res: unknown) => void)(req, res);
    });
  });
  await new Promise<void>((resolve) => upstream!.listen(0, "127.0.0.1", resolve));
  const upstreamPort = (upstream.address() as { port: number }).port;
  proxy = createEgressProxy({
    allow: [],
    allowPrivate: [],
    resolve: async (name) => (lookups.push(name), resolved),
    connect: (port, address) => (connects.push({ port, address }), netConnect(upstreamPort, "127.0.0.1")),
    log: (line) => lines.push(line),
    relay: { kind, placeholder: PLACEHOLDER, credential, tls: false, denyLocal },
  });
  const bound = await proxy.listen(0, null, "127.0.0.1", 0);
  return { port: bound.relayPort!, seen, lines, connects, lookups };
}

interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}
function send(port: number, options: { path?: string; headers?: Record<string, string>; body?: string; method?: string }): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method: options.method ?? "POST", path: options.path ?? "/v1/messages?beta=true", headers: options.headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject);
    req.end((options.method ?? "POST") === "POST" ? (options.body ?? "{}") : undefined);
  });
}

const oauth = { authorization: `Bearer ${PLACEHOLDER}`, "anthropic-version": "2023-06-01", "anthropic-beta": "x-beta", "content-type": "application/json" };

describe("the engine relay", () => {
  it("streams the response: the first chunk reaches the client before the upstream ends", async () => {
    let upstreamEnded = 0;
    const { port } = await start((_req, res) => {
      const out = res as import("node:http").ServerResponse;
      out.writeHead(200, { "content-type": "text/event-stream" });
      out.write("event: first\n\n");
      setTimeout(() => out.write("event: second\n\n"), 300);
      setTimeout(() => {
        upstreamEnded = Date.now();
        out.end("event: done\n\n");
      }, 600);
    });
    const firstAt = await new Promise<number>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, method: "POST", path: "/v1/messages?beta=true", headers: oauth }, (res) => {
        res.once("data", () => resolve(Date.now()));
        res.resume();
      });
      req.on("error", reject);
      req.end("{}");
    });
    expect(upstreamEnded).toBe(0);
    expect(firstAt).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 700));
    expect(upstreamEnded).toBeGreaterThan(firstAt);
  });

  it("ends the client's response when the upstream dies mid-stream, and logs the request", async () => {
    const { port, lines } = await start((_req, res) => {
      const out = res as import("node:http").ServerResponse;
      out.writeHead(200, { "content-type": "text/event-stream" });
      out.write("event: first\n\n");
      setTimeout(() => out.socket?.destroy(), 50);
    });
    const outcome = await new Promise<string>((resolve) => {
      const timer = setTimeout(() => resolve("hung"), 2000);
      const req = request({ host: "127.0.0.1", port, method: "POST", path: "/v1/messages?beta=true", headers: oauth }, (res) => {
        res.on("data", () => {});
        res.on("error", () => (clearTimeout(timer), resolve("errored")));
        res.on("aborted", () => (clearTimeout(timer), resolve("errored")));
        res.on("close", () => (clearTimeout(timer), resolve(res.complete ? "complete" : "errored")));
      });
      req.on("error", () => (clearTimeout(timer), resolve("errored")));
      req.end("{}");
    });
    expect(outcome).toBe("errored");
    await new Promise((r) => setTimeout(r, 100));
    expect(lines.map((l) => JSON.parse(l) as { relay: Record<string, unknown> }).some((l) => l.relay.path === "/v1/messages" && l.relay.aborted === true)).toBe(true);
  });

  it("replaces the OAuth placeholder with the real token and keeps the path, the query and the other headers", async () => {
    const { port, seen } = await start((_req, res) => (res as import("node:http").ServerResponse).end("ok"));
    const reply = await send(port, { headers: oauth, body: '{"a":1}' });
    expect(reply).toMatchObject({ status: 200, body: "ok" });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("/v1/messages?beta=true");
    expect(seen[0]!.body).toBe('{"a":1}');
    expect(seen[0]!.headers.authorization).toBe(`Bearer ${REAL}`);
    expect(seen[0]!.headers["x-api-key"]).toBeUndefined();
    expect(seen[0]!.headers["anthropic-beta"]).toBe("x-beta");
    expect(seen[0]!.headers["anthropic-version"]).toBe("2023-06-01");
    expect(seen[0]!.headers.host).toBe("api.anthropic.com");
  });

  it("replaces the API-key placeholder in x-api-key", async () => {
    const { port, seen } = await start((_req, res) => (res as import("node:http").ServerResponse).end("ok"), "api-key");
    const reply = await send(port, { headers: { "x-api-key": PLACEHOLDER, "anthropic-version": "2023-06-01" } });
    expect(reply.status).toBe(200);
    expect(seen[0]!.headers["x-api-key"]).toBe(REAL);
    expect(seen[0]!.headers.authorization).toBeUndefined();
  });

  for (const status of [429, 401]) {
    it(`passes an upstream ${status} through with its status, headers and body, and logs the status`, async () => {
      const body = JSON.stringify({ type: "error", error: { type: status === 429 ? "rate_limit_error" : "authentication_error", message: "no" } });
      const { port, lines } = await start((_req, res) => {
        (res as import("node:http").ServerResponse).writeHead(status, {
          "content-type": "application/json",
          "retry-after": "17",
          "anthropic-ratelimit-unified-status": "rejected",
          "anthropic-ratelimit-unified-reset": "1790000000",
          "anthropic-ratelimit-unified-representative-claim": "five_hour",
        });
        (res as import("node:http").ServerResponse).end(body);
      });
      const reply = await send(port, { headers: oauth });
      expect(reply.status).toBe(status);
      expect(reply.body).toBe(body);
      expect(reply.headers["retry-after"]).toBe("17");
      expect(reply.headers["anthropic-ratelimit-unified-status"]).toBe("rejected");
      expect(reply.headers["anthropic-ratelimit-unified-reset"]).toBe("1790000000");
      expect(reply.headers["anthropic-ratelimit-unified-representative-claim"]).toBe("five_hour");
      expect(reply.headers["content-type"]).toBe("application/json");
      await new Promise((r) => setTimeout(r, 50));
      expect(lines.map((l) => JSON.parse(l) as { relay: Record<string, unknown> })[0]!.relay).toMatchObject({ method: "POST", path: "/v1/messages", status });
    });
  }

  it("refuses a request that does not carry the run's placeholder, and never reaches the upstream", async () => {
    const { port, seen } = await start((_req, res) => (res as import("node:http").ServerResponse).end("ok"));
    expect((await send(port, { headers: { authorization: "Bearer sk-ant-oat01-guess" } })).status).toBe(401);
    expect((await send(port, { headers: { authorization: REAL } })).status).toBe(401);
    expect((await send(port, { headers: {} })).status).toBe(401);
    expect((await send(port, { headers: { "x-api-key": PLACEHOLDER } })).status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it("refuses another host or path, and never reaches the upstream", async () => {
    const { port, seen, connects } = await start((_req, res) => (res as import("node:http").ServerResponse).end("ok"));
    expect((await send(port, { path: "http://evil.example.com/v1/messages", headers: oauth })).status).toBe(403);
    expect((await send(port, { path: "/oauth/token", headers: oauth })).status).toBe(403);
    expect((await send(port, { path: "/v1/../admin", headers: oauth })).status).toBe(403);
    expect((await send(port, { path: "//evil.example.com/v1/x", headers: oauth })).status).toBe(403);
    expect(seen).toHaveLength(0);
    expect(connects).toHaveLength(0);
  });

  it("allows POST /v1/messages and POST /v1/messages/count_tokens (with a query) and nothing else, logging each refused path", async () => {
    const { port, seen, lines } = await start((_req, res) => (res as import("node:http").ServerResponse).end("ok"));
    expect((await send(port, { path: "/v1/messages", headers: oauth })).status).toBe(200);
    expect((await send(port, { path: "/v1/messages/count_tokens?beta=true", headers: oauth })).status).toBe(200);
    expect(seen).toHaveLength(2);
    const refused: Array<[string, string]> = [
      ["POST", "/v1/models"],
      ["POST", "/v1/messages/batches"],
      ["POST", "/v1/messages/"],
      ["POST", "/v1/messages/count_tokens/x"],
      ["GET", "/v1/messages"],
      ["DELETE", "/v1/messages"],
      ["POST", "/v1/%2e%2e/admin"],
      ["POST", "/v1/%2E%2E/admin"],
      ["POST", "/v1/messages%2Fbatches"],
      ["POST", "/v1/mess%61ges"],
    ];
    for (const [method, path] of refused) expect((await send(port, { method, path, headers: oauth })).status, `${method} ${path}`).toBe(403);
    expect(seen).toHaveLength(2);
    const logged = lines.map((l) => JSON.parse(l) as { relay: Record<string, unknown> }).filter((l) => l.relay.refused === "path");
    expect(logged.map((l) => l.relay.path)).toContain("/v1/models");
    expect(logged.map((l) => l.relay.path)).toContain("/v1/%2e%2e/admin");
    expect(logged).toHaveLength(refused.length);
  });

  it("resolves only api.anthropic.com, and refuses when it answers a private address", async () => {
    const ok = await start((_req, res) => (res as import("node:http").ServerResponse).end("ok"));
    await send(ok.port, { headers: oauth });
    expect(ok.lookups).toEqual(["api.anthropic.com"]);
    expect(ok.connects).toEqual([{ port: 443, address: PUBLIC }]);
    await proxy!.close();
    await new Promise<void>((resolve) => upstream!.close(() => resolve()));
    const bad = await start((_req, res) => (res as import("node:http").ServerResponse).end("ok"), "oauth", ["10.0.0.5"]);
    expect((await send(bad.port, { headers: oauth })).status).toBe(502);
    expect(bad.seen).toHaveLength(0);
  });

  it("refuses a request that arrives on the egress bridge's address, and serves one that arrives anywhere else", async () => {
    // The test's listener is 127.0.0.1: denying 127.0.0.0/8 stands for a request on the bridge side.
    const denied = await start((_req, res) => (res as import("node:http").ServerResponse).end("ok"), "oauth", [PUBLIC], ["127.0.0.0/8"]);
    expect((await send(denied.port, { headers: oauth })).status).toBe(403);
    expect(denied.seen).toHaveLength(0);
    expect(denied.connects).toHaveLength(0);
    expect(denied.lines.map((l) => JSON.parse(l) as { relay: Record<string, unknown> })[0]!.relay).toMatchObject({ refused: "local", status: 403 });
    await proxy!.close();
    await new Promise<void>((resolve) => upstream!.close(() => resolve()));
    const other = await start((_req, res) => (res as import("node:http").ServerResponse).end("ok"), "oauth", [PUBLIC], ["172.18.0.0/16", "10.9.9.9"]);
    expect((await send(other.port, { headers: oauth })).status).toBe(200);
  });

  it("reads the placeholder and the kind from the mounted file's text, and refuses anything else", () => {
    expect(parseRelayMeta('{"kind":"oauth","placeholder":"sk-ant-oat01-luna-relay-x"}')).toEqual({ kind: "oauth", placeholder: "sk-ant-oat01-luna-relay-x" });
    expect(parseRelayMeta('{"kind":"api-key","placeholder":"p"}')).toEqual({ kind: "api-key", placeholder: "p" });
    for (const bad of ["", "nope", '{"kind":"x","placeholder":"p"}', '{"kind":"oauth"}', '{"kind":"oauth","placeholder":""}']) expect(parseRelayMeta(bad), bad).toBeNull();
  });

  it("logs one JSON line per request with no header value", async () => {
    const { port, lines } = await start((_req, res) => (res as import("node:http").ServerResponse).end("ok"));
    await send(port, { headers: oauth });
    await send(port, { headers: { authorization: "Bearer wrong-value-here" } });
    const parsed = lines.map((l) => JSON.parse(l) as { relay: Record<string, unknown> });
    expect(parsed).toHaveLength(2);
    expect(parsed[0]!.relay).toMatchObject({ method: "POST", path: "/v1/messages", status: 200 });
    expect(parsed[1]!.relay).toMatchObject({ refused: "placeholder", status: 401 });
    const text = lines.join("\n");
    for (const secret of [REAL, PLACEHOLDER, "wrong-value-here"]) expect(text).not.toContain(secret);
  });
});
