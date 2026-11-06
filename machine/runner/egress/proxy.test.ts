import { createSocket } from "node:dgram";
import { type Server, type Socket, connect as netConnect, createServer } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type EgressProxy, createEgressProxy, isAddressTarget, isPublicV4, matchHost, refusalFor, serverNameOf } from "./proxy.ts";

// ---- helpers: a ClientHello built by hand, an echo server, and a client that speaks to the proxy ----
function clientHello(sni: string | null, opts: { ech?: boolean; twoNames?: boolean } = {}): Buffer {
  const u16 = (n: number) => Buffer.from([n >> 8, n & 255]);
  const ext = (type: number, data: Buffer) => Buffer.concat([u16(type), u16(data.length), data]);
  const nameEntry = (n: string) => Buffer.concat([Buffer.from([0]), u16(n.length), Buffer.from(n, "latin1")]);
  const exts: Buffer[] = [];
  if (sni !== null) {
    const list = Buffer.concat([nameEntry(sni), ...(opts.twoNames ? [nameEntry("other.example.com")] : [])]);
    exts.push(ext(0, Buffer.concat([u16(list.length), list])));
  }
  if (opts.ech) exts.push(ext(0xfe0d, Buffer.from([1, 2, 3])));
  exts.push(ext(0x000a, Buffer.concat([u16(2), u16(0x001d)])));
  const extensions = Buffer.concat(exts);
  const body = Buffer.concat([u16(0x0303), Buffer.alloc(32, 7), Buffer.from([0]), u16(2), u16(0x1301), Buffer.from([1, 0]), u16(extensions.length), extensions]);
  const handshake = Buffer.concat([Buffer.from([1, 0, body.length >> 8, body.length & 255]), body]);
  return Buffer.concat([Buffer.from([0x16, 0x03, 0x01]), u16(handshake.length), handshake]);
}

const PUBLIC = "93.184.216.34";
let echo: Server;
let echoPort = 0;
let proxy: EgressProxy;
let port = 0;
let dnsPort = 0;
let lines: Array<Record<string, unknown>> = [];
let connects: Array<{ port: number; address: string }> = [];
let lookups: string[] = [];
let answers: Record<string, string[]> = {};
const sockets = new Set<Socket>();

async function start(allow: string[], allowPrivate: string[] = []): Promise<void> {
  proxy = createEgressProxy({
    allow,
    allowPrivate,
    resolve: async (name) => {
      lookups.push(name);
      const a = answers[name];
      if (!a) throw new Error("NXDOMAIN");
      return a;
    },
    connect: (p, address) => {
      connects.push({ port: p, address });
      return netConnect(echoPort, "127.0.0.1");
    },
    log: (line) => lines.push(JSON.parse(line)),
  });
  const bound = await proxy.listen(0, 0, "127.0.0.1");
  port = bound.port;
  dnsPort = bound.dnsPort!;
}

beforeEach(async () => {
  lines = [];
  connects = [];
  lookups = [];
  answers = { "good.example.com": [PUBLIC], "api.good.example.com": [PUBLIC], "other.example.com": [PUBLIC] };
  echo = createServer((s) => s.pipe(s));
  await new Promise<void>((r) => echo.listen(0, "127.0.0.1", () => r()));
  echoPort = (echo.address() as { port: number }).port;
});

afterEach(async () => {
  for (const s of sockets) s.destroy();
  sockets.clear();
  await proxy?.close();
  await new Promise<void>((r) => echo.close(() => r()));
});

/** Sends raw bytes to the proxy, collects what comes back until it closes or `wait` ms pass. */
function talk(chunks: Array<Buffer | string>, wait = 300, gap = 0): Promise<string> {
  return new Promise((resolve) => {
    const s = netConnect(port, "127.0.0.1");
    sockets.add(s);
    let out = Buffer.alloc(0);
    s.on("data", (d: Buffer) => (out = Buffer.concat([out, d])));
    s.on("error", () => {});
    s.on("close", () => resolve(out.toString("latin1")));
    s.on("connect", async () => {
      for (const c of chunks) {
        s.write(c);
        if (gap) await new Promise((r) => setTimeout(r, gap));
      }
    });
    setTimeout(() => {
      s.destroy();
      resolve(out.toString("latin1"));
    }, wait);
  });
}
const connectLine = (target: string) => `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`;
const status = (reply: string) => reply.split("\r\n")[0];
const blockedRows = () => lines.filter((l) => "blocked" in l).map((l) => l.blocked as Record<string, unknown>);

describe("matchHost", () => {
  it("matches an exact name, or any name below *.suffix, on the entry's port only", () => {
    expect(matchHost(["github.com:443"], "github.com", 443)).toBe(true);
    expect(matchHost(["github.com:443"], "GITHUB.com", 443)).toBe(true);
    expect(matchHost(["github.com:443"], "github.com", 80)).toBe(false);
    expect(matchHost(["github.com:443"], "api.github.com", 443)).toBe(false);
    expect(matchHost(["*.example.com:443"], "a.b.example.com", 443)).toBe(true);
    expect(matchHost(["*.example.com:443"], "example.com", 443)).toBe(false);
    expect(matchHost(["*.example.com:443"], "evilexample.com", 443)).toBe(false);
    expect(matchHost(["*.example.com:443"], "example.com.evil.org", 443)).toBe(false);
    expect(matchHost(["x.example.com"], "x.example.com", 443)).toBe(true);
  });
});

describe("what is an address and what is public", () => {
  it("calls IP literals in every spelling, localhost and a name with no dot an address", () => {
    for (const h of ["1.2.3.4", "2130706433", "0x7f000001", "0177.0.0.1", "127.1", "[::1]", "::1", "::ffff:127.0.0.1", "fe80::1%eth0", "localhost", "foo.localhost", "intranet", "", "1.2.3.4."]) expect(isAddressTarget(h), h).toBe(true);
    for (const h of ["good.example.com", "xn--bcher-kva.example", "a.b"]) expect(isAddressTarget(h), h).toBe(false);
  });

  it("refuses every special-use IPv4 block and accepts a public one", () => {
    for (const a of ["0.1.2.3", "10.0.0.1", "100.64.0.1", "100.127.255.255", "127.0.0.1", "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.168.1.1", "224.0.0.1", "255.255.255.255", "198.18.0.1", "not an ip"]) expect(isPublicV4(a), a).toBe(false);
    for (const a of ["93.184.216.34", "1.1.1.1", "172.15.0.1", "172.32.0.1", "100.63.0.1", "100.128.0.1"]) expect(isPublicV4(a), a).toBe(true);
  });
});

describe("serverNameOf", () => {
  it("reads the name, none, an encrypted hello and rubbish", () => {
    expect(serverNameOf(clientHello("Good.Example.com"))).toBe("good.example.com");
    expect(serverNameOf(clientHello(null))).toBeNull();
    expect(serverNameOf(clientHello("good.example.com", { ech: true }))).toBe("ech");
    expect(serverNameOf(clientHello("good.example.com", { twoNames: true }))).toBe("bad");
    expect(serverNameOf(Buffer.from("GET / HTTP/1.1\r\n\r\n"))).toBe("bad");
    expect(serverNameOf(clientHello("good.example.com").subarray(0, 20))).toBe("bad");
  });
});

describe("CONNECT", () => {
  it("tunnels a listed name to the address it resolved, and nowhere else", async () => {
    await start(["good.example.com:443"]);
    const hello = clientHello("good.example.com");
    const reply = await talk([connectLine("good.example.com:443"), hello]);
    expect(status(reply)).toBe("HTTP/1.1 200 Connection Established");
    expect(reply.endsWith(hello.toString("latin1"))).toBe(true);
    expect(connects).toEqual([{ port: 443, address: PUBLIC }]);
    expect(lookups).toEqual(["good.example.com"]);
    expect(lines).toEqual([]);
  });

  it("tunnels any name below a wildcard, and a non-443 port with no SNI rule", async () => {
    await start(["*.good.example.com:443", "good.example.com:8443"]);
    const reply = await talk([connectLine("api.good.example.com:443"), clientHello("api.good.example.com")]);
    expect(status(reply)).toBe("HTTP/1.1 200 Connection Established");
    const plain = await talk([connectLine("good.example.com:8443"), "hello"]);
    expect(plain).toContain("200 Connection Established");
    expect(plain.endsWith("hello")).toBe(true);
    expect(connects.map((c) => c.port)).toEqual([443, 8443]);
  });

  it("refuses a name that is not listed with 403 and one log line, and a listed name on another port", async () => {
    await start(["good.example.com:443"]);
    expect(status(await talk([connectLine("evil.example.com:443")]))).toBe("HTTP/1.1 403 Forbidden");
    expect(status(await talk([connectLine("good.example.com:8443")]))).toBe("HTTP/1.1 403 Forbidden");
    expect(blockedRows()).toEqual([
      { host: "evil.example.com", port: 443, via: "connect", reason: "not_listed" },
      { host: "good.example.com", port: 8443, via: "connect", reason: "not_listed" },
    ]);
    expect(lookups).toEqual([]);
    expect(connects).toEqual([]);
  });

  it("refuses an address, localhost and a dotless name as `address` before any lookup", async () => {
    await start(["good.example.com:443"]);
    for (const t of ["93.184.216.34:443", "127.0.0.1:443", "2130706433:443", "0x7f000001:443", "localhost:443", "intranet:443", "[::1]:443", "[::ffff:7f00:1]:443", "169.254.169.254:443"]) {
      expect(status(await talk([connectLine(t)])), t).toBe("HTTP/1.1 403 Forbidden");
    }
    expect(blockedRows().every((r) => r.reason === "address" && r.via === "connect")).toBe(true);
    expect(blockedRows()).toHaveLength(9);
    expect(lookups).toEqual([]);
  });

  it("refuses a listed name that resolves to a private address, or to a public one beside a private one", async () => {
    await start(["good.example.com:443", "other.example.com:443"]);
    answers["good.example.com"] = ["10.0.0.5"];
    answers["other.example.com"] = [PUBLIC, "192.168.0.9"];
    expect(status(await talk([connectLine("good.example.com:443")]))).toBe("HTTP/1.1 403 Forbidden");
    expect(status(await talk([connectLine("other.example.com:443")]))).toBe("HTTP/1.1 403 Forbidden");
    expect(blockedRows().map((r) => r.reason)).toEqual(["private_address", "private_address"]);
    expect(connects).toEqual([]);
  });

  it("lets an allowPrivate entry skip the private-address rule and no other, and never as a wildcard", async () => {
    await start(["other.example.com:443"], ["good.example.com:9000", "*.example.net:9000"]);
    answers["good.example.com"] = ["172.17.0.4"];
    const ok = await talk([connectLine("good.example.com:9000"), "ping"]);
    expect(ok).toContain("200 Connection Established");
    expect(ok.endsWith("ping")).toBe(true);
    expect(connects).toEqual([{ port: 9000, address: "172.17.0.4" }]);
    // not on port 443, not an address, and a wildcard private entry is ignored
    expect(status(await talk([connectLine("good.example.com:443")]))).toBe("HTTP/1.1 403 Forbidden");
    answers["a.example.net"] = ["10.0.0.1"];
    expect(status(await talk([connectLine("a.example.net:9000")]))).toBe("HTTP/1.1 403 Forbidden");
    expect(status(await talk([connectLine("127.0.0.1:9000")]))).toBe("HTTP/1.1 403 Forbidden");
  });

  it("connects to the address it checked and looks the name up once, whatever it would answer next", async () => {
    await start(["good.example.com:443"]);
    let calls = 0;
    answers = {};
    Object.defineProperty(answers, "good.example.com", { get: () => (calls++ === 0 ? [PUBLIC] : ["127.0.0.1"]), enumerable: true });
    await talk([connectLine("good.example.com:443"), clientHello("good.example.com")]);
    expect(calls).toBe(1);
    expect(connects).toEqual([{ port: 443, address: PUBLIC }]);
  });

  it("answers 502 and logs a lookup that fails", async () => {
    await start(["nx.example.com:443"]);
    expect(status(await talk([connectLine("nx.example.com:443")]))).toBe("HTTP/1.1 502 Bad Gateway");
    expect(blockedRows()).toEqual([{ host: "nx.example.com", port: 443, via: "connect", reason: "unresolved" }]);
  });
});

describe("the TLS server name on port 443", () => {
  it("closes a tunnel whose ClientHello names another host, names none, is encrypted or is not TLS, and forwards nothing", async () => {
    await start(["good.example.com:443"]);
    const cases: Array<Buffer | string> = [clientHello("other.example.com"), clientHello(null), clientHello("good.example.com", { ech: true }), clientHello("good.example.com", { twoNames: true }), "GET / HTTP/1.1\r\nHost: good.example.com\r\n\r\n"];
    for (const first of cases) {
      const reply = await talk([connectLine("good.example.com:443"), first]);
      expect(reply).toBe("HTTP/1.1 200 Connection Established\r\n\r\n");
    }
    expect(connects).toEqual([]);
    expect(blockedRows()).toEqual([{ host: "good.example.com", port: 443, via: "connect", reason: "sni_mismatch" }]);
  });

  it("accepts a ClientHello that arrives in pieces and a name with a trailing dot or capitals", async () => {
    await start(["good.example.com:443"]);
    const hello = clientHello("GOOD.example.com");
    const reply = await talk([connectLine("good.example.com:443"), hello.subarray(0, 3), hello.subarray(3, 40), hello.subarray(40)], 600, 30);
    expect(reply.endsWith(hello.toString("latin1"))).toBe(true);
    expect(connects).toHaveLength(1);
  });

  it("takes bytes sent in the same packet as the CONNECT", async () => {
    await start(["good.example.com:443"]);
    const hello = clientHello("good.example.com");
    const reply = await talk([Buffer.concat([Buffer.from(connectLine("good.example.com:443")), hello])]);
    expect(reply.endsWith(hello.toString("latin1"))).toBe(true);
  });
});

describe("plain HTTP", () => {
  it("forwards an absolute-form request for a listed name on port 80, in origin form, to the checked address", async () => {
    await start(["good.example.com:80"]);
    const seen: string[] = [];
    echo.close();
    echo = createServer((s) => s.once("data", (d) => { seen.push(d.toString()); s.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok"); }));
    await new Promise<void>((r) => echo.listen(0, "127.0.0.1", () => r()));
    echoPort = (echo.address() as { port: number }).port;
    const reply = await talk(["GET http://good.example.com/a/b?c=1 HTTP/1.1\r\nHost: good.example.com\r\nProxy-Authorization: x\r\nConnection: close\r\n\r\n"], 500);
    expect(status(reply)).toBe("HTTP/1.1 200 OK");
    expect(reply.endsWith("ok")).toBe(true);
    expect(seen[0]).toMatch(/^GET \/a\/b\?c=1 HTTP\/1\.1\r\n/);
    expect(seen[0]).toMatch(/host: good\.example\.com/i);
    expect(seen[0]).not.toMatch(/proxy-authorization/i);
    expect(connects).toEqual([{ port: 80, address: PUBLIC }]);
  });

  it("refuses a name not listed on port 80, a port other than 80, and an address, logging via http", async () => {
    await start(["good.example.com:443", "good.example.com:8080"]);
    expect(status(await talk(["GET http://good.example.com/ HTTP/1.1\r\nHost: good.example.com\r\n\r\n"]))).toBe("HTTP/1.1 403 Forbidden");
    expect(status(await talk(["GET http://good.example.com:8080/ HTTP/1.1\r\nHost: good.example.com\r\n\r\n"]))).toBe("HTTP/1.1 403 Forbidden");
    expect(status(await talk(["GET http://93.184.216.34/ HTTP/1.1\r\nHost: x\r\n\r\n"]))).toBe("HTTP/1.1 403 Forbidden");
    expect(blockedRows()).toEqual([
      { host: "good.example.com", port: 80, via: "http", reason: "not_listed" },
      { host: "good.example.com", port: 8080, via: "http", reason: "not_listed" },
      { host: "93.184.216.34", port: 80, via: "http", reason: "address" },
    ]);
    expect(connects).toEqual([]);
  });

  it("answers 400 to a request in origin form: the proxy has no routes of its own", async () => {
    await start(["good.example.com:80"]);
    for (const path of ["/", "/status", "/metrics", "/admin", "/healthz"]) expect(status(await talk([`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`])), path).toBe("HTTP/1.1 400 Bad Request");
  });

  it("caps the request head at 8 KB", async () => {
    await start(["good.example.com:80"]);
    const reply = await talk([`GET http://good.example.com/ HTTP/1.1\r\nHost: good.example.com\r\nX-Pad: ${"a".repeat(9000)}\r\n\r\n`]);
    expect(status(reply)).toBe("HTTP/1.1 431 Request Header Fields Too Large");
    expect(connects).toEqual([]);
  });
});

describe("DNS", () => {
  function udpQuery(name: string): Promise<Buffer> {
    const labels = name.split(".").map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l, "latin1")]));
    const q = Buffer.concat([Buffer.from([0xab, 0xcd, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0]), ...labels, Buffer.from([0, 0, 1, 0, 1])]);
    return new Promise((resolve, reject) => {
      const s = createSocket("udp4");
      s.on("message", (m) => { s.close(); resolve(m); });
      s.send(q, dnsPort, "127.0.0.1", (e) => e && reject(e));
      setTimeout(() => { s.close(); reject(new Error("no answer")); }, 1000);
    });
  }

  it("answers a UDP query REFUSED, keeping the id and the question, and logs the name asked", async () => {
    await start(["good.example.com:443"]);
    const reply = await udpQuery("data.exfil.example.org");
    expect(reply.readUInt16BE(0)).toBe(0xabcd);
    expect(reply.readUInt16BE(2) & 0x800f).toBe(0x8005);
    expect(reply.readUInt16BE(6)).toBe(0);
    expect(blockedRows()).toEqual([{ host: "data.exfil.example.org", port: 53, via: "dns", reason: "not_listed" }]);
  });

  it("refuses even a listed name: nothing is resolved for a container", async () => {
    await start(["good.example.com:443"]);
    const reply = await udpQuery("good.example.com");
    expect(reply.readUInt16BE(2) & 0xf).toBe(5);
    expect(lookups).toEqual([]);
  });

  it("answers a TCP query REFUSED with a length prefix", async () => {
    await start([]);
    const q = Buffer.concat([Buffer.from([0x12, 0x34, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0, 3]), Buffer.from("abc"), Buffer.from([0, 0, 0, 1, 0, 1])]);
    const framed = Buffer.concat([Buffer.from([0, q.length]), q]);
    const reply = await new Promise<Buffer>((resolve) => {
      const s = netConnect(dnsPort, "127.0.0.1");
      sockets.add(s);
      let out = Buffer.alloc(0);
      s.on("data", (d: Buffer) => { out = Buffer.concat([out, d]); if (out.length >= 2 + out.readUInt16BE(0)) resolve(out); });
      s.on("connect", () => s.write(framed));
      setTimeout(() => resolve(out), 800);
    });
    expect(reply.readUInt16BE(0)).toBe(reply.length - 2);
    expect(reply.readUInt16BE(4) & 0xf).toBe(5);
    expect(blockedRows()).toEqual([{ host: "abc", port: 53, via: "dns", reason: "not_listed" }]);
  });

  it("reads a name that is not text safely: control bytes are flattened, a long name is cut", () => {
    const long = Buffer.concat([Buffer.from([1, 0x0a, 1, 0x22, 63]), Buffer.alloc(63, 0x61), Buffer.from([0]), Buffer.from([0, 1, 0, 1])]);
    const q = Buffer.concat([Buffer.from([0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]), long]);
    const out = refusalFor(q)!;
    expect(out.name.startsWith("\n.\".")).toBe(true);
    expect(refusalFor(Buffer.from("short"))).toBeNull();
  });
});

describe("the log", () => {
  it("writes each distinct (host, port, via) once, a count at each power of ten, and counts the rest past 200 distinct", async () => {
    await start([]);
    for (let i = 0; i < 12; i++) await talk([connectLine("evil.example.com:443")], 50);
    expect(blockedRows().filter((r) => r.host === "evil.example.com")).toEqual([
      { host: "evil.example.com", port: 443, via: "connect", reason: "not_listed" },
      { host: "evil.example.com", port: 443, via: "connect", reason: "not_listed", count: 10 },
    ]);
    for (let i = 0; i < 205; i++) await talk([connectLine(`h${i}.example.com:443`)], 20);
    const distinct = new Set(blockedRows().map((r) => `${r.host}${r.port}${r.via}`));
    expect(distinct.size).toBeLessThanOrEqual(200);
    expect(lines.some((l) => "more" in l)).toBe(true);
  }, 30_000);

  it("never writes a line break or control character of a hostile name unescaped", async () => {
    await start([]);
    await talk(["CONNECT evil\u0001host.example.com:443 HTTP/1.1\r\n\r\n"], 100);
    for (const row of blockedRows()) expect(String(row.host)).not.toMatch(/[\u0000-\u001f]/);
  });
});
