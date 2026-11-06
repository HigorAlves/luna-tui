// The egress proxy: the only door out of a run's network. The machine starts it as its own container, on the run's
// internal network and on one ordinary bridge, with the run's list on this command line:
//   node /opt/luna/egress/proxy.ts --listen 3128 --allow <host:port,...> --allow-private <host:port,...>
// A stage container cannot change the list: it is not in the container. One file of erasable TypeScript that imports
// only `node:` modules, so the image's Node runs it as is.
//
// What it does: tunnels a CONNECT to a listed name and port (address checked, TLS server name checked), forwards a
// plain HTTP request for a listed name on port 80, answers every DNS query with REFUSED, and says on stdout, one JSON
// line each, what it refused. It reads no response, so it follows no redirect. Every name here comes from hostile code.
import { createSocket } from "node:dgram";
import { Resolver, promises as dnsPromises } from "node:dns";
const dnsLookup = dnsPromises.lookup;
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import type { IncomingMessage, Server as HttpServer, ServerResponse } from "node:http";
import { connect as netConnect, createServer as createNetServer, isIP } from "node:net";
import type { Server as NetServer, Socket } from "node:net";
import { fileURLToPath } from "node:url";

export type Via = "connect" | "http" | "dns";
export type Reason = "not_listed" | "address" | "private_address" | "sni_mismatch" | "unresolved" | "head_too_large";

export const MAX_HEAD_BYTES = 8192;
export const CONNECT_TIMEOUT_MS = 10_000;
const HELLO_TIMEOUT_MS = 10_000;
const IDLE_TIMEOUT_MS = 300_000;
const RESOLVE_TIMEOUT_MS = 5_000;
const MAX_DISTINCT = 200;
const MAX_CONNECTIONS = 512;
const MAX_HELLO_BYTES = 16_384 + 5;
const MAX_NAME = 253;

/** `host` or `host:port` entries (443 when no port). An exact name matches itself, `*.suffix` matches any name below it. */
export function matchHost(entries: readonly string[], host: string, port: number): boolean {
  const name = host.toLowerCase();
  for (const raw of entries) {
    const entry = raw.toLowerCase();
    const colon = entry.lastIndexOf(":");
    const entryPort = colon >= 0 ? Number(entry.slice(colon + 1)) : 443;
    const pattern = colon >= 0 ? entry.slice(0, colon) : entry;
    if (entryPort !== port) continue;
    if (pattern.startsWith("*.")) {
      const suffix = pattern.slice(1);
      if (name.length > suffix.length && name.endsWith(suffix)) return true;
    } else if (pattern === name) return true;
  }
  return false;
}

/** True for a target that is an address in any spelling (dotted, decimal, hex or octal IPv4, any IPv6, IPv4-mapped), `localhost` or a name with no dot: refused before any lookup. */
export function isAddressTarget(host: string): boolean {
  const name = host.toLowerCase().replace(/\.$/, "");
  if (name === "" || name.includes(":") || name.startsWith("[") || name.includes("%")) return true;
  if (name === "localhost" || name.endsWith(".localhost")) return true;
  if (!name.includes(".")) return true;
  return /^(0x[0-9a-f]*|\d+)$/.test(name.slice(name.lastIndexOf(".") + 1));
}

/** True for a public unicast IPv4 address; every special-use block is refused. */
export function isPublicV4(address: string): boolean {
  if (isIP(address) !== 4) return false;
  const [a, b, c] = address.split(".").map(Number) as [number, number, number];
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

/** The SNI of a TLS ClientHello held whole in `buffer`: a name, `null` for none, `"ech"` for an encrypted ClientHello, `"bad"` for anything else. */
export function serverNameOf(buffer: Buffer): string | null | "ech" | "bad" {
  if (buffer.length < 5 || buffer[0] !== 0x16 || buffer[1] !== 0x03) return "bad";
  const recordLength = buffer.readUInt16BE(3);
  if (buffer.length < 5 + recordLength) return "bad";
  const hello = buffer.subarray(5, 5 + recordLength);
  if (hello.length < 4 || hello[0] !== 0x01) return "bad";
  const bodyLength = (hello[1]! << 16) | (hello[2]! << 8) | hello[3]!;
  if (4 + bodyLength > hello.length) return "bad";
  const body = hello.subarray(4, 4 + bodyLength);
  let at = 2 + 32;
  const skip = (lengthBytes: 1 | 2): boolean => {
    if (at + lengthBytes > body.length) return false;
    const length = lengthBytes === 1 ? body[at]! : body.readUInt16BE(at);
    at += lengthBytes + length;
    return at <= body.length;
  };
  if (!skip(1) || !skip(2) || !skip(1)) return "bad";
  if (at === body.length) return null;
  if (at + 2 > body.length) return "bad";
  const extensionsEnd = at + 2 + body.readUInt16BE(at);
  at += 2;
  if (extensionsEnd > body.length) return "bad";
  let name: string | null = null;
  while (at + 4 <= extensionsEnd) {
    const type = body.readUInt16BE(at);
    const length = body.readUInt16BE(at + 2);
    const data = body.subarray(at + 4, at + 4 + length);
    if (at + 4 + length > extensionsEnd) return "bad";
    at += 4 + length;
    if (type === 0xfe0d) return "ech";
    if (type !== 0x0000) continue;
    if (name !== null || data.length < 5) return "bad";
    const listEnd = 2 + data.readUInt16BE(0);
    if (listEnd !== data.length || data[2] !== 0) return "bad";
    const nameLength = data.readUInt16BE(3);
    if (5 + nameLength !== listEnd) return "bad";
    name = data.subarray(5, 5 + nameLength).toString("latin1").toLowerCase().replace(/\.$/, "");
  }
  return name;
}

/** A REFUSED reply to a DNS query, and the name asked, or null when the bytes are not a query. */
export function refusalFor(query: Buffer): { reply: Buffer; name: string } | null {
  if (query.length < 12) return null;
  const flags = query.readUInt16BE(2);
  if ((flags & 0x8000) !== 0) return null;
  let at = 12;
  const labels: string[] = [];
  for (;;) {
    const length = query[at];
    if (length === undefined) return null;
    if (length === 0) {
      at += 1;
      break;
    }
    if ((length & 0xc0) !== 0 || at + 1 + length > query.length || at - 12 > 255) return null;
    labels.push(query.subarray(at + 1, at + 1 + length).toString("latin1"));
    at += 1 + length;
  }
  const end = at + 4;
  if (end > query.length) return null;
  const reply = Buffer.from(query.subarray(0, end));
  reply.writeUInt16BE(0x8000 | (flags & 0x7800) | (flags & 0x0100) | 0x0005, 2);
  reply.writeUInt16BE(1, 4);
  reply.writeUInt16BE(0, 6);
  reply.writeUInt16BE(0, 8);
  reply.writeUInt16BE(0, 10);
  return { reply, name: labels.length === 0 ? "." : labels.join(".") };
}

/** Text safe to put in a log line and a JSON string: printable ASCII only, cut at 253. */
function clean(text: string): string {
  return text.slice(0, MAX_NAME).replace(/[^\x21-\x7e]/g, "?");
}

export interface ProxyOptions {
  allow: readonly string[];
  allowPrivate: readonly string[];
  /** The A records of a name. */
  resolve: (name: string) => Promise<string[]>;
  /** For an exact `allowPrivate` name only: the addresses the container's own name service gives it, the hosts file included (`--add-host` entries). Default: `resolve`. */
  resolvePrivate?: (name: string) => Promise<string[]>;
  /** A socket to an address and port the proxy has already checked. */
  connect: (port: number, address: string) => Socket;
  log: (line: string) => void;
}

export interface EgressProxy {
  /** Binds the proxy on `port` and, when given, DNS refusal on `dnsPort` (UDP and TCP). Port 0 picks one. */
  listen(port: number, dnsPort: number | null, host?: string): Promise<{ port: number; dnsPort: number | null }>;
  close(): Promise<void>;
}

const isRound = (n: number): boolean => n >= 10 && /^10*$/.test(String(n));

export function createEgressProxy(options: ProxyOptions): EgressProxy {
  const exactPrivate = options.allowPrivate.filter((entry) => !entry.startsWith("*"));
  const seen = new Map<string, number>();
  let overflow = 0;

  const say = (value: unknown): void => options.log(JSON.stringify(value));
  /** One line the first time a (host, port, via) is refused, another at each power of ten; past 200 distinct ones, a count of the rest. */
  const blocked = (rawHost: string, port: number, via: Via, reason: Reason): void => {
    const host = clean(rawHost);
    const key = `${via}|${host}|${port}`;
    const count = seen.get(key);
    if (count !== undefined) {
      seen.set(key, count + 1);
      if (isRound(count + 1)) say({ blocked: { host, port, via, reason, count: count + 1 } });
      return;
    }
    if (seen.size >= MAX_DISTINCT) {
      overflow += 1;
      if (overflow === 1 || isRound(overflow)) say({ more: overflow });
      return;
    }
    seen.set(key, 1);
    say({ blocked: { host, port, via, reason } });
  };

  const withTimeout = <T>(work: Promise<T>, ms: number): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout")), ms);
      work.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
    });

  /** The address to connect to, or the reason this target is refused. The name is resolved once, here. */
  async function authorize(host: string, port: number, via: Via, onlyPort?: number): Promise<{ address: string } | { reason: Reason }> {
    const refuse = (reason: Reason) => {
      blocked(host, port, via, reason);
      return { reason };
    };
    if (isAddressTarget(host)) return refuse("address");
    const name = host.toLowerCase().replace(/\.$/, "");
    if (onlyPort !== undefined && port !== onlyPort) return refuse("not_listed");
    const privateOk = matchHost(exactPrivate, name, port);
    if (!privateOk && !matchHost(options.allow, name, port)) return refuse("not_listed");
    let addresses: string[];
    try {
      addresses = await withTimeout((privateOk ? (options.resolvePrivate ?? options.resolve) : options.resolve)(name), RESOLVE_TIMEOUT_MS);
    } catch {
      return refuse("unresolved");
    }
    if (addresses.length === 0 || addresses.some((a) => isIP(a) !== 4)) return refuse("unresolved");
    if (!privateOk && !addresses.every(isPublicV4)) return refuse("private_address");
    return { address: addresses[0]! };
  }

  const deny = (socket: Socket, status: string): void => {
    socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  };

  const pipeBoth = (a: Socket, b: Socket): void => {
    const close = (): void => {
      a.destroy();
      b.destroy();
    };
    a.on("error", close);
    b.on("error", close);
    a.on("close", close);
    b.on("close", close);
    a.setTimeout(IDLE_TIMEOUT_MS, close);
    b.setTimeout(IDLE_TIMEOUT_MS, close);
    a.pipe(b);
    b.pipe(a);
  };

  /** An upstream socket to a checked address; `onReady` when connected, `onFail` on error or after ten seconds. */
  const openUpstream = (address: string, port: number, onReady: (socket: Socket) => void, onFail: () => void): void => {
    const upstream = options.connect(port, address);
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      upstream.destroy();
      onFail();
    }, CONNECT_TIMEOUT_MS);
    upstream.once("error", () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      upstream.destroy();
      onFail();
    });
    upstream.once("connect", () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      upstream.removeAllListeners("error");
      onReady(upstream);
    });
  };

  /** Reads until a whole TLS record is in hand (or gives up), starting from bytes already read. */
  const readHello = (socket: Socket, first: Buffer, done: (hello: Buffer | null) => void): void => {
    let chunks = first;
    let finished = false;
    const finish = (result: Buffer | null): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onEnd);
      socket.off("close", onEnd);
      socket.pause();
      done(result);
    };
    const check = (): void => {
      if (chunks.length > 0 && (chunks[0] !== 0x16 || (chunks.length > 1 && chunks[1] !== 0x03))) return finish(chunks);
      if (chunks.length < 5) return;
      const need = 5 + chunks.readUInt16BE(3);
      if (need > MAX_HELLO_BYTES) return finish(chunks);
      if (chunks.length >= need) finish(chunks);
    };
    const onData = (data: Buffer): void => {
      chunks = Buffer.concat([chunks, data]);
      check();
    };
    const onEnd = (): void => finish(null);
    const timer = setTimeout(() => finish(null), HELLO_TIMEOUT_MS);
    socket.on("data", onData);
    socket.once("error", onEnd);
    socket.once("close", onEnd);
    check();
  };

  function onConnect(req: IncomingMessage, client: Socket, head: Buffer): void {
    client.on("error", () => client.destroy());
    const target = /^([^:\s]+):(\d{1,5})$/.exec(req.url ?? "");
    if (!target) {
      const raw = req.url ?? "";
      if (raw.includes(":") && (raw.startsWith("[") || (raw.match(/:/g) ?? []).length > 1)) blocked(raw, 0, "connect", "address");
      else blocked(raw, 0, "connect", "not_listed");
      return deny(client, "403 Forbidden");
    }
    const host = target[1]!.toLowerCase();
    const port = Number(target[2]);
    if (port < 1 || port > 65535) return deny(client, "400 Bad Request");
    void authorize(host, port, "connect").then((verdict) => {
      if ("reason" in verdict) return deny(client, verdict.reason === "unresolved" ? "502 Bad Gateway" : "403 Forbidden");
      const bare = host.replace(/\.$/, "");
      const connectUpstream = (initial: Buffer): void => {
        openUpstream(verdict.address, port, (upstream) => {
          if (port !== 443) client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          if (initial.length > 0) upstream.write(initial);
          client.resume();
          pipeBoth(client, upstream);
        }, () => deny(client, "502 Bad Gateway"));
      };
      if (port !== 443) return connectUpstream(head);
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      readHello(client, head, (hello) => {
        if (hello === null) return client.destroy();
        const name = serverNameOf(hello);
        if (name !== bare) {
          blocked(bare, port, "connect", "sni_mismatch");
          return client.destroy();
        }
        connectUpstream(hello);
      });
    });
  }

  const HOP = new Set(["connection", "proxy-connection", "proxy-authorization", "proxy-authenticate", "keep-alive", "upgrade", "te", "trailer"]);

  function onRequest(req: IncomingMessage, res: ServerResponse): void {
    const reply = (status: number): void => {
      res.writeHead(status, { Connection: "close", "Content-Length": "0" });
      res.end();
    };
    let url: URL;
    try {
      if (!/^http:\/\//i.test(req.url ?? "")) return reply(400);
      url = new URL(req.url!);
    } catch {
      return reply(400);
    }
    if (url.username || url.password) return reply(400);
    const port = url.port === "" ? 80 : Number(url.port);
    // Port 80 for a listed name; the machine's own private entry (its trace endpoint, plain HTTP) on the port it names.
    const own = matchHost(exactPrivate, url.hostname, port);
    void authorize(url.hostname, port, "http", own ? port : 80).then((verdict) => {
      if ("reason" in verdict) return reply(verdict.reason === "unresolved" ? 502 : 403);
      const headers: Record<string, string | string[]> = {};
      for (const [key, value] of Object.entries(req.headers)) if (value !== undefined && !HOP.has(key)) headers[key] = value;
      headers.host = url.host;
      // No `agent`: with a `createConnection` and no agent the request uses only the socket the proxy checked.
      const upstream = httpRequest({ method: req.method, path: `${url.pathname}${url.search}`, headers, createConnection: () => options.connect(port, verdict.address) });
      upstream.setTimeout(CONNECT_TIMEOUT_MS * 3, () => upstream.destroy());
      upstream.on("response", (response) => {
        const out: Record<string, string | string[]> = {};
        for (const [key, value] of Object.entries(response.headers)) if (value !== undefined && !HOP.has(key)) out[key] = value;
        res.writeHead(response.statusCode ?? 502, out);
        response.pipe(res);
      });
      upstream.on("error", () => {
        if (!res.headersSent) reply(502);
        else res.destroy();
      });
      req.pipe(upstream);
    });
  }

  const http: HttpServer = createHttpServer({ maxHeaderSize: MAX_HEAD_BYTES, headersTimeout: 10_000, requestTimeout: 60_000, keepAliveTimeout: 1 }, onRequest);
  http.maxConnections = MAX_CONNECTIONS;
  http.on("connect", onConnect);
  http.on("clientError", (error: Error & { code?: string }, socket: Socket) => {
    if (error.code === "HPE_HEADER_OVERFLOW") {
      blocked("-", 0, "http", "head_too_large");
      socket.end("HTTP/1.1 431 Request Header Fields Too Large\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    } else socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  });

  const udp = createSocket("udp4");
  udp.on("message", (message, remote) => {
    const refusal = refusalFor(message);
    if (!refusal) return;
    blocked(refusal.name, 53, "dns", "not_listed");
    udp.send(refusal.reply, remote.port, remote.address);
  });
  udp.on("error", () => {});

  const dnsTcp: NetServer = createNetServer((socket) => {
    let buffered = Buffer.alloc(0);
    socket.setTimeout(5_000, () => socket.destroy());
    socket.on("error", () => socket.destroy());
    socket.on("data", (data: Buffer) => {
      buffered = Buffer.concat([buffered, data]);
      while (buffered.length >= 2) {
        const length = buffered.readUInt16BE(0);
        if (length > 1024) return socket.destroy();
        if (buffered.length < 2 + length) return;
        const refusal = refusalFor(buffered.subarray(2, 2 + length));
        buffered = buffered.subarray(2 + length);
        if (!refusal) return socket.destroy();
        blocked(refusal.name, 53, "dns", "not_listed");
        const prefix = Buffer.alloc(2);
        prefix.writeUInt16BE(refusal.reply.length, 0);
        socket.write(Buffer.concat([prefix, refusal.reply]));
      }
    });
  });
  dnsTcp.maxConnections = 256;

  const listening = (server: HttpServer | NetServer, port: number, host: string): Promise<number> =>
    new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => resolve((server.address() as { port: number }).port));
    });

  return {
    async listen(port, dnsPort, host = "0.0.0.0") {
      const bound = await listening(http, port, host);
      if (dnsPort === null) return { port: bound, dnsPort: null };
      const tcpPort = await listening(dnsTcp, dnsPort, host);
      await new Promise<void>((resolve, reject) => {
        udp.once("error", reject);
        udp.bind(tcpPort, host, () => resolve());
      });
      return { port: bound, dnsPort: tcpPort };
    },
    async close() {
      http.closeAllConnections();
      await Promise.all([new Promise<void>((r) => http.close(() => r())), new Promise<void>((r) => dnsTcp.close(() => r())), new Promise<void>((r) => { try { udp.close(() => r()); } catch { r(); } })]);
    },
  };
}

/** The A records of a name through the container's own resolver, one try, four seconds. */
export function systemResolve(): (name: string) => Promise<string[]> {
  const resolver = new Resolver({ timeout: 4000, tries: 1 });
  return (name) => new Promise((resolve, reject) => resolver.resolve4(name, (error, addresses) => (error ? reject(error) : resolve(addresses))));
}

/** IPv4 addresses of a name through getaddrinfo, which reads the hosts file: used only for the machine's own private entries. */
export function systemLookup(): (name: string) => Promise<string[]> {
  return async (name) => (await dnsLookup(name, { family: 4, all: true })).map((entry) => entry.address);
}

function listOf(value: string | undefined): string[] {
  return (value ?? "").split(",").map((entry) => entry.trim().toLowerCase()).filter((entry) => entry.length > 0);
}

/** The functions above on known inputs: `--check` exits 0 when the file runs on this Node. */
function selfCheck(): boolean {
  const refusal = refusalFor(Buffer.from("123401000001000000000000076578616d706c6503636f6d0000010001", "hex"));
  return (
    matchHost(["*.example.com:443"], "a.example.com", 443) &&
    !matchHost(["*.example.com:443"], "example.com", 443) &&
    isAddressTarget("0x7f.1") &&
    !isPublicV4("10.1.2.3") &&
    isPublicV4("93.184.216.34") &&
    refusal?.name === "example.com" &&
    refusal.reply.readUInt16BE(2) === 0x8105 &&
    serverNameOf(Buffer.from("474554", "hex")) === "bad"
  );
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const value = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  if (args.includes("--check")) process.exit(selfCheck() ? 0 : 1);
  const port = Number(value("--listen") ?? "3128");
  const proxy = createEgressProxy({
    allow: listOf(value("--allow")),
    allowPrivate: listOf(value("--allow-private")),
    resolve: systemResolve(),
    resolvePrivate: systemLookup(),
    connect: (p, address) => netConnect(p, address),
    log: (line) => process.stdout.write(`${line}\n`),
  });
  proxy.listen(port, 53).then(
    () => process.stdout.write(`${JSON.stringify({ ready: { port } })}\n`),
    (error: unknown) => {
      process.stderr.write(`egress proxy: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    },
  );
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => process.exit(0));
}
