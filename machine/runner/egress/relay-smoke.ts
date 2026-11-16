// One real Claude Agent SDK query through the egress proxy's relay, with the user's own credential. Not part of the test
// suite and never run by CI: it spends one tiny model call. It is condition 2 of RFC 0009's go for the relay.
//
//   pnpm --filter @hardness/machine relay:smoke
//
// It starts the proxy's relay on 127.0.0.1 with the real credential in a 0444 file (as the machine does), gives the SDK
// only a placeholder and `ANTHROPIC_BASE_URL`, and checks three things:
//   1. the reply streams: partial messages arrive before the result does;
//   2. the init `system` message's `permissionMode` is printed (CLAUDE_CODE_SUBPROCESS_ENV_SCRUB is known to force `default`);
//   3. a tool in `allowedTools` (Read) runs while one outside it (Bash) is denied.
// It prints no credential value, only kinds, counts, tool names and the relay's own log lines (which carry no header).
// The credential comes as the machine finds it: CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_API_KEY, then ~/.config/hardness.
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { connect as netConnect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { loadCredential } from "../../src/adapters/credentials/claude.ts";
import { createEgressProxy, systemResolve } from "./proxy.ts";

const here = dirname(fileURLToPath(import.meta.url));
/** The SDK lives in the factory's runtime folder only (CLAUDE.md); this script borrows it by path, so machine imports none. */
const SDK_FILE = join(here, "..", "..", "..", "factory", "node_modules", "@anthropic-ai", "claude-agent-sdk", "sdk.mjs");

interface Block { type: string; id?: string; name?: string; tool_use_id?: string; is_error?: boolean }
interface Message { type: string; subtype?: string; permissionMode?: string; message?: { content?: Block[] | string }; is_error?: boolean }
type Query = (args: { prompt: string; options: Record<string, unknown> }) => AsyncIterable<Message>;

const credential = await loadCredential();
if (!credential) {
  console.error("no Claude credential: set CLAUDE_CODE_OAUTH_TOKEN (or ANTHROPIC_API_KEY), or put claude-oauth-token in ~/.config/hardness");
  process.exit(2);
}
const oauth = credential.name === "CLAUDE_CODE_OAUTH_TOKEN";
console.log(`credential kind: ${oauth ? "subscription token (authorization: Bearer)" : "API key (x-api-key)"}`);

const root = await mkdtemp(join(tmpdir(), "relay-smoke-"));
const relayDir = join(root, "relay");
await mkdir(relayDir, { mode: 0o700 });
const file = join(relayDir, "anthropic");
await writeFile(file, credential.value, { mode: 0o444 });
await chmod(file, 0o444);
const work = join(root, "work");
await mkdir(work);
await writeFile(join(work, "allowed.txt"), "relay-smoke-ok\n");

const placeholder = `${oauth ? "sk-ant-oat01-" : "sk-ant-api03-"}luna-relay-smoke`;
const lines: string[] = [];
const proxy = createEgressProxy({
  allow: [],
  allowPrivate: [],
  resolve: systemResolve(),
  connect: (port, address) => netConnect(port, address),
  log: (line) => lines.push(line),
  relay: { kind: oauth ? "oauth" : "api-key", placeholder, credential: async () => (await import("node:fs/promises")).readFile(file, "utf8").then((t) => t.replace(/\s+/g, "")) },
});
const bound = await proxy.listen(0, null, "127.0.0.1", 0);

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = ""): void => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures.push(name);
};

try {
  const { query } = (await import(pathToFileURL(SDK_FILE).href)) as { query: Query };
  // The stage's own environment, as the factory runs the SDK: no real credential, a placeholder and the relay.
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  delete env.ANTHROPIC_API_KEY;
  env[credential.name] = placeholder;
  env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${bound.relayPort}`;
  env.NO_PROXY = "127.0.0.1";
  env.no_proxy = "127.0.0.1";
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB = "1";

  const started = Date.now();
  let firstPartialAt = 0;
  let partials = 0;
  let resultAt = 0;
  let resultError = false;
  let permissionMode = "(no init message)";
  const uses = new Map<string, string>();
  const outcomes = new Map<string, boolean>();
  const prompt = "Do exactly two things. First use the Read tool on allowed.txt. Then use the Bash tool to run `echo bash-was-allowed`. Then say which of the two worked, in one short sentence.";
  for await (const message of query({
    prompt,
    options: { cwd: work, env, tools: ["Read", "Bash"], allowedTools: ["Read"], permissionMode: "dontAsk", maxTurns: 6, settingSources: [], includePartialMessages: true },
  })) {
    if (message.type === "system" && message.subtype === "init") permissionMode = message.permissionMode ?? "(not reported)";
    if (message.type === "stream_event") {
      partials += 1;
      if (firstPartialAt === 0) firstPartialAt = Date.now();
    }
    const content = message.message?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === "tool_use" && block.id && block.name) uses.set(block.id, block.name);
        if (block.type === "tool_result" && block.tool_use_id) outcomes.set(block.tool_use_id, block.is_error !== true);
      }
    }
    if (message.type === "result") {
      resultAt = Date.now();
      resultError = message.is_error === true;
    }
  }
  const worked = (tool: string): boolean | null => {
    for (const [id, name] of uses) if (name === tool) return outcomes.get(id) ?? null;
    return null;
  };

  console.log(`init permissionMode: ${permissionMode}`);
  check("the query ended with a result, not an error", resultAt > 0 && !resultError);
  check("the reply streams: partial messages arrive before the result", partials > 1 && firstPartialAt > 0 && firstPartialAt < resultAt, `${partials} partials, first at +${firstPartialAt - started}ms, result at +${resultAt - started}ms`);
  check("a tool in allowedTools runs (Read)", worked("Read") === true);
  check("a tool outside allowedTools is denied (Bash)", worked("Bash") !== true, worked("Bash") === null ? "never attempted" : "attempted and refused");
  if (permissionMode !== "dontAsk") console.log(`note: permissionMode is "${permissionMode}", not "dontAsk": the allowedTools result above is what holds in this mode`);
} catch (error) {
  failures.push("the query threw");
  console.log(`FAIL  the query threw  (${error instanceof Error ? error.message.slice(0, 200) : "unknown"})`);
} finally {
  await proxy.close();
  await rm(root, { recursive: true, force: true });
}

const relayed = lines.flatMap((l) => {
  try {
    return [JSON.parse(l) as { relay?: { method: string; path: string; status: number; refused?: string } }];
  } catch {
    return [];
  }
}).filter((l) => l.relay);
console.log(`relay log: ${relayed.length} lines`);
for (const l of relayed) console.log(`  ${JSON.stringify(l.relay)}`);
check("every relayed request was accepted by the API (no 401 or refusal)", relayed.length > 0 && relayed.every((l) => l.relay!.status >= 200 && l.relay!.status < 400));
console.log(failures.length === 0 ? "relay smoke: all checks passed" : `relay smoke: ${failures.length} failed`);
process.exit(failures.length === 0 ? 0 : 1);
