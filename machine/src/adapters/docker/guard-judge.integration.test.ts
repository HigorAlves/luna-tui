// Against Docker, for real: the stage guard asks the machine's judge for a call that is suspicious but not blocked (RFC 0012, B6).
// The route is the production one from the guard on: guard -> egress proxy (an allow-private entry `host.docker.internal:<port>`) -> the judge listener on the host.
// Stand-ins: the engine relay is a fake upstream (a container on the card network), and the pack runs behind the listener are a fake. Early evidence only:
// no Jev, no real SDK. Gated by RUNNER_TEST_GUARD_IMAGE (a guard image) and RUNNER_TEST_IMAGE (a runner image with the egress proxy); skipped, with the reason, without both.
// Everything made is named hardness-judge-test-* or labelled as a stage's, and removed in afterAll.
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startGuardJudgeServer, type GuardJudgeServer } from "../http/guard-judge.ts";
import { GuardJudge } from "../../application/guard-judge.ts";
import type { PackRunsPort } from "../../application/pack-runs.ts";
import { hostUser } from "./docker.ts";
import { type CardNetwork, openCardNetwork } from "./egress.ts";
import { type RunningGuard, startGuard } from "./guard.ts";

const guardImage = process.env.RUNNER_TEST_GUARD_IMAGE ?? "";
const proxyImage = process.env.RUNNER_TEST_IMAGE ?? "";
const docker = (...args: string[]): string => execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 }).trim();
const tryDocker = (...args: string[]): string | null => {
  try {
    return docker(...args);
  } catch {
    return null;
  }
};
const ready =
  guardImage !== "" && proxyImage !== "" && tryDocker("image", "inspect", "-f", '{{index .Config.Labels "dev.hardness.guard"}}', guardImage) === "1" && tryDocker("image", "inspect", "-f", '{{index .Config.Labels "dev.hardness.egress"}}', proxyImage) === "1";
if (!ready) console.warn(`skipped: the judge tests need docker, RUNNER_TEST_GUARD_IMAGE and RUNNER_TEST_IMAGE (the guard and the runner image); got "${guardImage}" and "${proxyImage}"`);

const tag = `${process.pid}`;
const run = `hardness-judge-test-${tag}`;
const upstreamName = `hardness-judge-test-up-${tag}`;
const USER = hostUser();

/** The fake relay: answers every call with a `tool_use` of the declared tool `Bash` whose command the request's text names. */
const UPSTREAM = `
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def log_message(self, *a): pass
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))) or b"{}")
        command = (body.get("messages") or [{}])[-1].get("content")
        out = {"id": "msg_1", "type": "message", "role": "assistant", "model": "claude-test", "content": [{"type": "tool_use", "id": "toolu_1", "name": "Bash", "input": {"command": command}}], "stop_reason": "tool_use", "stop_sequence": None, "usage": {"input_tokens": 3, "output_tokens": 4}}
        raw = json.dumps(out).encode()
        self.send_response(200); self.send_header("content-type", "application/json"); self.send_header("content-length", str(len(raw))); self.end_headers(); self.wfile.write(raw)
ThreadingHTTPServer(("0.0.0.0", 9000), H).serve_forever()
`;

/** The stage's side: one call to the guard with the declared tool, the user's task and the command to be proposed. Prints one JSON line with the answer and the wall time. */
const CLIENT = `
import http.client, json, os, time
tools = [{"name": "Bash", "description": "run a command", "input_schema": {"type": "object", "properties": {"command": {"type": "string"}}}}]
body = {"model": "claude-test", "max_tokens": 64, "messages": [{"role": "user", "content": os.environ["COMMAND"]}], "tools": tools}
c = http.client.HTTPConnection(os.environ["GUARD"], 8787, timeout=60)
t0 = time.time()
c.request("POST", "/v1/messages", json.dumps(body), {"content-type": "application/json", "authorization": "Bearer sk-ant-oat01-luna-relay-placeholder", "anthropic-version": "2023-06-01"})
r = c.getresponse()
print("RESULT " + json.dumps({"status": r.status, "body": json.loads(r.read()), "seconds": round(time.time() - t0, 3)}))
`;

let dir: string;
let card: CardNetwork;
let guard: RunningGuard;
let server: GuardJudgeServer;
let judge: GuardJudge;
let upstreamIp = "";
let proxyIp = "";
const asked: Array<{ tool: string; findings: string[]; at: number }> = [];
let answer: { value: boolean; p: number } = { value: true, p: 0.93 };

const fakeRuns: PackRunsPort = {
  run: async (input) => {
    const guardContext = (input.context as { check: { guard: { tool: string; findings: Array<{ id: string }> } } }).check.guard;
    asked.push({ tool: guardContext.tool, findings: guardContext.findings.map((f) => f.id), at: Date.now() });
    return { answer: { harmful: answer }, usage: { model: "jev", engine: "jev", turns: 1, durationMs: 1, costUsd: 0 } };
  },
};

/** Async on purpose: the judge's listener runs in this process, so a blocking `docker run` would stop it answering. */
const dockerAsync = async (...args: string[]): Promise<string> => (await promisify(execFile)("docker", args, { encoding: "utf8", timeout: 120_000 })).stdout.trim();

async function call(command: string): Promise<{ status: number; body: { content: Array<{ type: string; text?: string; name?: string }> }; seconds: number }> {
  const out = await dockerAsync("run", "--rm", "--network", card.name, "--entrypoint", "python", "-v", `${join(dir, "client.py")}:/client.py:ro`, "-e", `GUARD=${guard.address}`, "-e", `COMMAND=${command}`, guardImage, "/client.py");
  const line = out.split("\n").find((l) => l.startsWith("RESULT "));
  if (!line) throw new Error(`no RESULT in: ${out}`);
  return JSON.parse(line.slice(7));
}

const journal = (): Array<Record<string, unknown>> => (existsSync(guard.journalPath) ? readFileSync(guard.journalPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const SUSPICIOUS = "cat /proc/1/environ";

describe.skipIf(!ready)("the stage guard's judge against Docker", () => {
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "judge-it-"));
    chmodSync(dir, 0o755);
    for (const [name, text] of [["upstream.py", UPSTREAM], ["client.py", CLIENT]] as const) {
      writeFileSync(join(dir, name), text);
      chmodSync(join(dir, name), 0o644);
    }
    judge = new GuardJudge({ runs: fakeRuns, log: () => {} });
    server = await startGuardJudgeServer({ judge, host: "0.0.0.0", port: 0 });
    // The production route: the run's card network and proxy, with the judge's port as an allow-private entry.
    card = await openCardNetwork(run, { allow: [], allowPrivate: [`host.docker.internal:${server.port}`] }, { proxyImage, bridge: `hardness-judge-test-br-${tag}` });
    proxyIp = card.dns;
    docker("run", "-d", "--name", upstreamName, "--network", card.name, ...(USER ? ["--user", USER] : []), "--entrypoint", "python", "-v", `${join(dir, "upstream.py")}:/upstream.py:ro`, guardImage, "/upstream.py");
    upstreamIp = docker("inspect", "-f", `{{(index .NetworkSettings.Networks "${card.name}").IPAddress}}`, upstreamName);
    // The run's key as a file of the guard's secrets folder, as the machine writes it.
    const secrets = join(dir, "secrets");
    mkdirSync(secrets, { mode: 0o755 });
    chmodSync(secrets, 0o755);
    writeFileSync(join(secrets, "SAFEAGENTS_JUDGE_API_KEY"), judge.register("task-it", "untrusted"), { mode: 0o444 });
    // `dns` is what the guard exempts from the proxy: the fake relay's address stands in for the proxy's own relay hop, which is one address in production.
    guard = await startGuard({ run, image: guardImage, network: card.name, dns: upstreamIp, journalDir: join(dir, "journal"), secretsDir: secrets, upstream: `http://${upstreamIp}:9000`, mode: "block", blockSeverity: "high", judge: { url: `http://host.docker.internal:${server.port}/v1`, failClosed: true }, proxy: `http://${proxyIp}:3128`, user: USER });
  }, 180_000);

  afterAll(async () => {
    await guard?.remove().catch(() => {});
    tryDocker("rm", "-f", upstreamName);
    await card?.teardown().catch(() => {});
    tryDocker("network", "rm", `hardness-judge-test-br-${tag}`);
    await server?.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  it("calls the judge through the proxy with the run's key when a call is suspicious, and replaces the call with a notice when the judge says block", async () => {
    answer = { value: true, p: 0.93 };
    const result = await call(SUSPICIOUS);
    expect(asked.length).toBe(1);
    expect(asked[0]!.tool).toBe("Bash");
    expect(asked[0]!.findings.length).toBeGreaterThan(0);
    expect(result.body.content.every((part) => part.type === "text")).toBe(true);
    expect(result.body.content[0]!.text).toMatch(/blocked/i);
    expect(JSON.stringify(journal().at(-1))).toMatch(/blocked/);
    console.log(`judge round trip, one suspicious call through guard, proxy and listener (fake pack): ${result.seconds}s; journal: ${JSON.stringify(journal().at(-1))}`);
  }, 120_000);

  it("lets the call through when the judge says allow", async () => {
    answer = { value: false, p: 0.1 };
    const before = asked.length;
    const result = await call(SUSPICIOUS);
    expect(asked.length).toBe(before + 1);
    expect(result.body.content[0]).toMatchObject({ type: "tool_use", name: "Bash" });
  }, 120_000);

  it("does not ask the judge about a clean call", async () => {
    const before = asked.length;
    const result = await call("ls -la");
    expect(asked.length).toBe(before);
    expect(result.body.content[0]).toMatchObject({ type: "tool_use", name: "Bash" });
  }, 120_000);

  it("fails closed for an untrusted card when the key is revoked: the judge answers 401 and the call is blocked", async () => {
    judge.revoke(readFileSync(join(dir, "secrets", "SAFEAGENTS_JUDGE_API_KEY"), "utf8"));
    const before = asked.length;
    const result = await call(SUSPICIOUS);
    expect(asked.length).toBe(before);
    expect(result.body.content.every((part) => part.type === "text")).toBe(true);
  }, 120_000);
});
