// Against Docker, for real: a container on a card network can reach only what its proxy lets through. Skipped, with the reason, when
// docker or the test image is not there: RUNNER_TEST_IMAGE names a runner image built under a test tag
// (`RUNNER_REPO=hardness-runner-test-11c pnpm --filter @hardness/machine runner:build`, never `hardness-runner:dev`).
// Everything this file makes is named hardness-egress-test-*, hardness-card-test-* or labelled, and removed in afterAll, also when a test fails.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { execInSandbox } from "./docker.ts";
import { type CardNetwork, openCardNetwork } from "./egress.ts";

const image = process.env.RUNNER_TEST_IMAGE ?? "";
const docker = (...args: string[]): string => execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 }).trim();
const tryDocker = (...args: string[]): string | null => {
  try {
    return docker(...args);
  } catch {
    return null;
  }
};
const ready = image !== "" && tryDocker("image", "inspect", image) !== null && tryDocker("image", "inspect", "-f", '{{index .Config.Labels "dev.hardness.egress"}}', image) === "1";
if (!ready) console.warn(`skipped: the egress tests need docker and RUNNER_TEST_IMAGE (a runner image with the egress proxy); got "${image}"`);

const tag = `${process.pid}`;
const bridge = `hardness-egress-test-br-${tag}`;
const serverName = `hardness-egress-test-srv-${tag}`;
const SERVER_HOST = "srv.test.example";
const PROBE = `
const net = require("node:net");
const dns = require("node:dns").promises;
const ops = JSON.parse(process.env.PROBE);
const proxy = process.env.PROXY;
const tcp = (host, port) => new Promise((resolve) => {
  const s = net.connect({ host, port, family: net.isIPv6(host) ? 6 : 4 });
  const t = setTimeout(() => { s.destroy(); resolve({ ok: false, code: "TIMEOUT" }); }, 4000);
  s.on("connect", () => { clearTimeout(t); s.destroy(); resolve({ ok: true }); });
  s.on("error", (e) => { clearTimeout(t); resolve({ ok: false, code: e.code }); });
});
const via = (target, after) => new Promise((resolve) => {
  const s = net.connect(3128, proxy);
  let buf = "";
  let sent = false;
  const t = setTimeout(() => { s.destroy(); resolve({ status: "TIMEOUT", body: buf }); }, 6000);
  s.on("error", (e) => { clearTimeout(t); resolve({ status: e.code, body: buf }); });
  s.on("connect", () => s.write("CONNECT " + target + " HTTP/1.1\\r\\nHost: " + target + "\\r\\n\\r\\n"));
  s.on("data", (d) => {
    buf += d.toString();
    if (!sent && buf.includes("\\r\\n\\r\\n")) {
      sent = true;
      if (!buf.startsWith("HTTP/1.1 200")) { clearTimeout(t); s.destroy(); return resolve({ status: buf.split("\\r\\n")[0], body: "" }); }
      s.write(after);
    }
    if (sent && buf.includes("hello-from-srv")) { clearTimeout(t); s.destroy(); resolve({ status: "HTTP/1.1 200", body: buf }); }
  });
  s.on("close", () => { clearTimeout(t); resolve({ status: buf.split("\\r\\n")[0] || "CLOSED", body: buf }); });
});
const http = (url) => new Promise((resolve) => {
  const s = net.connect(3128, proxy);
  let buf = "";
  const t = setTimeout(() => { s.destroy(); resolve({ status: "TIMEOUT", body: buf }); }, 6000);
  s.on("error", (e) => { clearTimeout(t); resolve({ status: e.code, body: buf }); });
  s.on("connect", () => s.write("GET " + url + " HTTP/1.1\\r\\nHost: x\\r\\nConnection: close\\r\\n\\r\\n"));
  s.on("data", (d) => { buf += d.toString(); });
  s.on("close", () => { clearTimeout(t); resolve({ status: buf.split("\\r\\n")[0] || "CLOSED", body: buf }); });
});
(async () => {
  const out = [];
  for (const op of ops) {
    if (op.op === "tcp") out.push(await tcp(op.host, op.port));
    else if (op.op === "lookup") { try { out.push({ ok: true, address: (await dns.lookup(op.name)).address }); } catch (e) { out.push({ ok: false, code: e.code }); } }
    else if (op.op === "via") out.push(await via(op.target, op.after || ""));
    else if (op.op === "http") out.push(await http(op.url));
  }
  console.log("RESULT " + JSON.stringify(out));
})();
`;

type Probe = { ok?: boolean; code?: string; address?: string; status?: string; body?: string };
const work = ready ? mkdtempSync(join(tmpdir(), "egress-test-")) : "";
if (ready) writeFileSync(join(work, "probe.js"), PROBE);
const opened: CardNetwork[] = [];

/** Runs the probe script in a container on `net`; its results, one per op. */
async function probe(net: CardNetwork, ops: unknown[], name: string): Promise<Probe[]> {
  const result = await execInSandbox({ name: `hardness-egress-test-probe-${tag}-${name}`, image, worktree: work, argv: ["/opt/luna/bin/node", "/work/probe.js"], env: { PROBE: JSON.stringify(ops), PROXY: net.dns }, cardNetwork: net }, { timeoutMs: 90_000 });
  const line = result.stdout.split("\n").find((l) => l.startsWith("RESULT "));
  if (!line) throw new Error(`the probe printed no result: ${result.stdout.slice(-300)} ${result.stderr.slice(-300)}`);
  return JSON.parse(line.slice("RESULT ".length)) as Probe[];
}

function sweep(): void {
  for (const filter of ["^hardness-egress-test-", "^hardness-egress-egress-test"]) {
    const names = tryDocker("ps", "-aq", "--filter", `name=${filter}`);
    if (names) tryDocker("rm", "-f", ...names.split("\n"));
  }
  for (const filter of ["hardness-card-test-", "hardness-egress-test-br"]) {
    const nets = tryDocker("network", "ls", "-q", "--filter", `name=${filter}`);
    if (nets) for (const id of nets.split("\n")) tryDocker("network", "rm", id);
  }
}

describe.skipIf(!ready)("a container on a card network, against Docker", () => {
  let list: CardNetwork;
  let strict: CardNetwork;
  let other: CardNetwork;
  let serverAddress = "";

  beforeAll(async () => {
    sweep();
    // The test's own bridge, plain (containers on it talk to each other), with a server on it the proxy may reach by name.
    docker("network", "create", bridge);
    docker("run", "-d", "--name", serverName, "--network", bridge, "--network-alias", SERVER_HOST, "--entrypoint", "/opt/luna/bin/node", image, "-e", "require('node:http').createServer((q,r)=>r.end('hello-from-srv')).listen(8080)");
    serverAddress = docker("inspect", "-f", `{{(index .NetworkSettings.Networks "${bridge}").IPAddress}}`, serverName);
    list = await openCardNetwork(`test-${tag}-a`, { allow: [], allowPrivate: [`${SERVER_HOST}:8080`] }, { proxyImage: image, bridge });
    strict = await openCardNetwork(`test-${tag}-b`, { allow: [`${SERVER_HOST}:8080`], allowPrivate: [] }, { proxyImage: image, bridge });
    other = await openCardNetwork(`test-${tag}-c`, { allow: ["github.com:443"], allowPrivate: [] }, { proxyImage: image, bridge });
    opened.push(list, strict, other);
  }, 180_000);

  afterAll(async () => {
    for (const net of opened) await net.teardown().catch(() => {});
    sweep();
    rmSync(work, { recursive: true, force: true });
  }, 120_000);

  it("reaches no outside address directly: IPv4 and IPv6 literals fail", async () => {
    const [v4, v6, metadata] = await probe(list, [{ op: "tcp", host: "1.1.1.1", port: 443 }, { op: "tcp", host: "2606:4700:4700::1111", port: 443 }, { op: "tcp", host: "169.254.169.254", port: 80 }], "direct");
    for (const r of [v4, v6, metadata]) expect(r!.ok).toBe(false);
  }, 120_000);

  it("resolves no outside name, and the lookup shows in blocked() as a dns row", async () => {
    const [looked] = await probe(list, [{ op: "lookup", name: "outside.example.org" }], "dns");
    expect(looked!.ok).toBe(false);
    const rows = await list.blocked();
    expect(rows).toContainEqual(expect.objectContaining({ host: "outside.example.org", via: "dns", port: 53 }));
  }, 120_000);

  it("answers a CONNECT to a name off the list with 403, and shows it in blocked()", async () => {
    const [refused] = await probe(list, [{ op: "via", target: "evil.example.com:443" }], "off-list");
    expect(refused!.status).toBe("HTTP/1.1 403 Forbidden");
    expect(await list.blocked()).toContainEqual(expect.objectContaining({ host: "evil.example.com", port: 443, via: "connect", reason: "not_listed" }));
  }, 120_000);

  it("refuses a CONNECT to an IPv4 literal, localhost, the proxy's own address, the metadata address and host.docker.internal", async () => {
    const targets = ["1.1.1.1:443", "localhost:3128", `${list.dns}:3128`, "169.254.169.254:80", "host.docker.internal:443", "2130706433:80", "[::1]:3128"];
    const results = await probe(list, targets.map((target) => ({ op: "via", target })), "refused");
    for (const [i, r] of results.entries()) expect(r.status, targets[i]).toBe("HTTP/1.1 403 Forbidden");
  }, 120_000);

  it("lets the listed test server answer through the proxy, and refuses the same server when it is named in allow instead", async () => {
    const get = `GET / HTTP/1.1\r\nHost: ${SERVER_HOST}\r\nConnection: close\r\n\r\n`;
    const [answered] = await probe(list, [{ op: "via", target: `${SERVER_HOST}:8080`, after: get }], "listed");
    expect(answered!.status).toBe("HTTP/1.1 200");
    expect(answered!.body).toContain("hello-from-srv");
    const [refused] = await probe(strict, [{ op: "via", target: `${SERVER_HOST}:8080`, after: get }], "strict");
    expect(refused!.status).toBe("HTTP/1.1 403 Forbidden");
    expect(await strict.blocked()).toContainEqual(expect.objectContaining({ host: SERVER_HOST, port: 8080, reason: "private_address" }));
  }, 120_000);

  it("refuses a plain HTTP request to any other host or port, an address, and the listed private server on a port it was not listed for", async () => {
    const urls = ["http://evil.example.com/", `http://${SERVER_HOST}:9999/`, "http://127.0.0.1/", "http://169.254.169.254/latest/meta-data/", "http://example.com:8080/"];
    const results = await probe(list, urls.map((url) => ({ op: "http", url })), "plain-http");
    for (const [i, r] of results.entries()) expect(r.status, urls[i]).toBe("HTTP/1.1 403 Forbidden");
    // the listed private entry on its own port is answered over plain HTTP (the trace endpoint's case)
    const [ok] = await probe(list, [{ op: "http", url: `http://${SERVER_HOST}:8080/` }], "plain-http-listed");
    expect(ok!.body).toContain("hello-from-srv");
  }, 120_000);

  it("has no gateway address that accepts a connection, and one run reaches neither another run's proxy nor its services", async () => {
    const gateway = docker("network", "inspect", "-f", "{{range .IPAM.Config}}{{.Gateway}}{{end}}", list.name);
    // Docker reports an isolated network's missing gateway as "invalid IP" (the zero address), never an address.
    expect(["", "invalid IP"]).toContain(gateway);
    const subnet = docker("network", "inspect", "-f", "{{range .IPAM.Config}}{{.Subnet}}{{end}}", list.name);
    // With no gateway the first address goes to the first container (the proxy): probe the addresses no container holds.
    const used = docker("network", "inspect", "-f", "{{range .Containers}}{{.IPv4Address}} {{end}}", list.name).split(" ").map((a) => a.replace(/\/\d+$/, ""));
    const base = subnet.replace(/\.0\/\d+$/, "");
    const dot1 = [`${base}.1`, `${base}.254`, `${base}.100`].find((a) => !used.includes(a))!;
    const otherProxy = docker("inspect", "-f", `{{(index .NetworkSettings.Networks "${other.name}").IPAddress}}`, "hardness-egress-test-" + tag + "-c");
    docker("run", "-d", "--name", `hardness-egress-test-svc-${tag}`, "--network", other.name, "--entrypoint", "/opt/luna/bin/node", image, "-e", "require('node:net').createServer((s)=>s.end('x')).listen(9000)");
    const svc = docker("inspect", "-f", `{{(index .NetworkSettings.Networks "${other.name}").IPAddress}}`, `hardness-egress-test-svc-${tag}`);
    const results = await probe(list, [{ op: "tcp", host: dot1, port: 3128 }, { op: "tcp", host: dot1, port: 53 }, { op: "tcp", host: dot1, port: 80 }, { op: "tcp", host: otherProxy, port: 3128 }, { op: "tcp", host: svc, port: 9000 }, { op: "tcp", host: serverAddress, port: 8080 }], "isolation");
    for (const [i, r] of results.entries()) {
      expect(r.ok, `target ${i}`).toBe(false);
      expect(r.code, `target ${i}`).not.toBe("ECONNREFUSED");
    }
  }, 120_000);

  it("leaves no container and no network of the run once torn down", async () => {
    const extra = await openCardNetwork(`test-${tag}-d`, { allow: ["github.com:443"], allowPrivate: [] }, { proxyImage: image, bridge });
    expect(tryDocker("ps", "-aq", "--filter", `name=hardness-egress-test-${tag}-d`)).not.toBe("");
    await extra.teardown();
    await extra.teardown();
    expect(tryDocker("ps", "-aq", "--filter", `name=hardness-egress-test-${tag}-d`)).toBe("");
    expect(tryDocker("network", "ls", "-q", "--filter", `name=hardness-card-test-${tag}-d`)).toBe("");
  }, 120_000);
});
