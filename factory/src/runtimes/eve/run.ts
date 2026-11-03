// The eve runtime: one stage through Vercel's eve, for every engine that is not a Claude model.
// The pack's agent was compiled and built at image time (compile.ts, build.ts); a run starts that
// built server on loopback with a per-run password, its working directory on the /tmp tmpfs (eve
// keeps its workflow store under <cwd>/.eve), sends the prompt with the pack's answer schema
// through eve/client, and follows the session's events into the transcript the way the Claude
// runtime prints them. The luna tools' state stays here: the agent's luna tools call back into
// this process over a loopback bridge with a per-run bearer token. The server always stops.
// LUNA_STAGE_DEBUG=1 also writes every session event to /out/raw.jsonl and the server's log to
// /out/eve-server.log.
import { type AgentPack, ENGINES, answerJsonSchema } from "@hardness/contracts";
import type { SendTurnOptions } from "eve/client";
import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { appendFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { type IncomingMessage, type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { type GuardContext, branchPrefixFor } from "../../core/guards.ts";
import { EMPTY_RUN, type RunOutcome } from "../../core/output.ts";
import { callLine } from "../../core/render.ts";
import type { RunContext, Runtime } from "../../core/runtime.ts";
import { eveTools } from "./compile.ts";
import type { EveSecrets } from "./agent/secrets.ts";

const env = process.env;
const HEALTHY_WITHIN_MS = 30_000;

export interface EveOptions {
  /** Where the built agents are, one folder per pack (default <factory>/.eve-agents). */
  agentsDir?: string;
  /** Extra environment for the server (the conformance fake's script). */
  serverEnv?: Record<string, string>;
}

/** The eve runtime over the agents in `options.agentsDir`. */
export function eveRuntime(options: EveOptions = {}): Runtime {
  return { id: "eve", run: (ctx) => run(ctx, options) };
}

export const eve: Runtime = eveRuntime();

/** The stage's guard policy, as the agent's tools read it from LUNA_EVE_GUARD. */
function guardPolicy(pack: AgentPack, { input, paths }: RunContext): GuardContext {
  return {
    writable: pack.writable,
    branch: input.task.branch || null,
    branchPrefix: branchPrefixFor(input.task),
    workRoot: paths.work,
    outRoot: paths.out,
    // eve's bash has no allow-list of its own: the pack's commands are enforced by the guard.
    commands: pack.access.commands,
    // The model's tools run as the same user as Codex and the runner: only the run's own roots
    // may be named, never the Codex home, HOME, /proc or the secrets file.
    roots: { scratch: paths.scratch, read: [paths.input] },
    web: pack.access.web,
  };
}

/** Variables that hold a credential: never in the server's environment. */
const SECRET_ENV = /^(GH_TOKEN|GITHUB_TOKEN|OPENAI_API_KEY|ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|TYPESAFE_API_KEY)$|(TOKEN|SECRET|PASSWORD|API_KEY)$/i;

/** The eve server's environment: the runner's without a credential, and the run's settings. */
export function serverEnv(source: NodeJS.ProcessEnv, extra: Record<string, string>): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) if (value !== undefined && !SECRET_ENV.test(key)) kept[key] = value;
  return { ...kept, ...extra };
}

/** Writes the run's secrets to a 0600 file in a 0700 folder of its own under /tmp, outside every
 *  root; returns the file. The caller removes the folder. */
export function writeSecrets(secrets: EveSecrets): string {
  const dir = mkdtempSync(join(tmpdir(), "luna-eve-secrets-"));
  const file = join(dir, "secrets.json");
  writeFileSync(file, JSON.stringify(secrets), { mode: 0o600 });
  return file;
}

async function run(ctx: RunContext, options: EveOptions): Promise<RunOutcome> {
  const { pack, engine, input, prompt, paths, luna, dry, out } = ctx;
  if (pack.kind !== "agent" || pack.agent === null) return { ...EMPTY_RUN, error: `pack ${pack.id} has no agent to run` };
  const app = join(options.agentsDir ?? join(paths.factoryRoot, ".eve-agents"), pack.id);
  const entry = join(app, ".output", "server", "index.mjs");
  const apiKey = (ENGINES[engine.id] as { auth?: string }).auth === "api-key";
  const guard = guardPolicy(pack, ctx);

  if (dry) {
    out(
      JSON.stringify(
        {
          agent: app,
          built: existsSync(entry),
          model: `${apiKey ? "openai" : "chatgpt"}(${engine.modelId})`,
          reasoning: pack.effort,
          tools: eveTools(pack.access),
          skills: pack.access.skills ? pack.skills : [],
          maxModelCalls: input.limits.maxTurns,
          outputSchema: pack.id,
          guard,
        },
        null,
        2,
      ),
    );
    let structured: Record<string, unknown> | null = null;
    try {
      structured = env.LUNA_STAGE_DRY_STRUCTURED ? (JSON.parse(env.LUNA_STAGE_DRY_STRUCTURED) as Record<string, unknown>) : null; // test seam
    } catch {}
    return { ...EMPTY_RUN, ok: true, structured, text: "dry-run" };
  }
  if (!existsSync(entry)) return { ...EMPTY_RUN, error: `the eve agent for ${pack.id} is not built (${app}); the runner image builds every agent` };

  const t0 = Date.now();
  // The pinned ID the server was given; eve's model.started names the agent's compiled default
  // for a model chosen at run time, so it is not read back.
  const result: RunOutcome = { ...EMPTY_RUN, model: engine.modelId };
  const bridgeToken = randomBytes(24).toString("hex");
  const bridge = await serveLuna(luna.call, bridgeToken);
  const password = randomBytes(24).toString("hex");
  const ghToken = env.GH_TOKEN || env.GITHUB_TOKEN || undefined;
  const secretsFile = writeSecrets({ password, bridgeToken, ...(ghToken && { ghToken }), ...(apiKey && env.OPENAI_API_KEY && { openaiApiKey: env.OPENAI_API_KEY }) });
  const port = await freePort();
  const state = mkdtempSync(join(tmpdir(), "eve-"));
  const log: string[] = [];
  const server = spawn(process.execPath, [entry], {
    cwd: state,
    env: serverEnv(env, {
      ...options.serverEnv,
      // eve swaps every authored model for its own mock under NODE_ENV=test (vitest sets it).
      NODE_ENV: "production",
      HOST: "127.0.0.1",
      PORT: String(port),
      EVE_TELEMETRY_DISABLED: "1",
      EVE_SCHEDULES_DISABLED: "1",
      LUNA_FACTORY: "1",
      LUNA_EVE_SECRETS: secretsFile,
      LUNA_EVE_MODEL: engine.modelId,
      LUNA_EVE_AUTH: apiKey ? "api-key" : "chatgpt",
      LUNA_EVE_WORKSPACE: paths.work,
      LUNA_EVE_SCRATCH: paths.scratch,
      LUNA_EVE_GUARD: JSON.stringify(guard),
      LUNA_EVE_BRIDGE_URL: bridge.url,
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const debug = env.LUNA_STAGE_DEBUG === "1";
  const keep = (b: Buffer) => {
    if (debug) appendFileSync(join(paths.out, "eve-server.log"), b);
    log.push(...String(b).split("\n").filter(Boolean));
    log.splice(0, Math.max(0, log.length - 50));
  };
  server.stdout?.on("data", keep);
  server.stderr?.on("data", keep);

  try {
    const { Client } = await import("eve/client");
    const client = new Client({ baseUrl: `http://127.0.0.1:${port}`, auth: { basic: { username: "stage", password } } });
    await waitHealthy(() => client.health(), server, log);
    // The pack's schema is plain JSON Schema; eve types it as its own JSON object.
    const outputSchema = answerJsonSchema(pack) as SendTurnOptions["outputSchema"];
    const { session, delivery } = await client.sessions.create({ message: prompt, outputSchema });
    result.sessionId = session.id;
    out(`session ${session.id} · eve agent ${pack.id} · ${apiKey ? "openai" : "chatgpt"}(${engine.modelId})`);

    const names = new Map<string, string>();
    let modelCalls = 0;
    let capped = false;
    let replyText = "";
    let failure: string | null = null;
    for await (const event of delivery.stream()) {
      if (debug) appendFileSync(join(paths.out, "raw.jsonl"), `${JSON.stringify(event)}\n`);
      const data = (event as unknown as { data?: Record<string, unknown> }).data ?? {};
      if (event.type === "model.requested" && (data.owner as { turnId?: string } | undefined)?.turnId) {
        modelCalls++;
        // eve retries an answer that misses the schema without a limit of its own: the pack's turn
        // budget caps the model calls, then the turn is cancelled.
        if (modelCalls > input.limits.maxTurns && !capped) {
          capped = true;
          await session.cancel();
        }
      } else if ((event.type === "model.settled" || event.type === "session.ended") && data.error) {
        // A model error eve will not retry ends the session and cancels the turn: keep its reason.
        const error = data.error as { code?: string; message?: string };
        failure = `${error.code ?? "error"}: ${error.message ?? ""}`;
      } else if (event.type === "content.completed") {
        if (data.kind === "result") result.structured = data.value as Record<string, unknown>;
        else if (data.kind === "text" && typeof data.value === "string") {
          out(data.value);
          if (data.phase === "reply") replyText = data.value;
        }
      } else if (event.type === "call.requested") {
        const capability = data.capability as { name?: string } | undefined;
        const name = capability?.name ?? "tool";
        names.set(String(data.callId), name);
        out(callLine(name, (data.input ?? {}) as Record<string, unknown>));
      } else if (event.type === "call.settled" && data.outcome !== "completed") {
        const error = data.error as { message?: string } | undefined;
        out(`  ✗ ${names.get(String(data.callId)) ?? "call"} ${String(data.outcome)}: ${error?.message ?? ""}`.trimEnd());
      } else if (event.type === "usage.recorded") {
        const usage = data.usage as { costUsd?: number } | undefined;
        if (typeof usage?.costUsd === "number") result.costUsd = (result.costUsd ?? 0) + usage.costUsd;
      } else if (event.type === "turn.paused" && !capped) {
        // A continuation or approval prompt: nobody is here to answer it.
        capped = true;
        result.error = "the turn stopped to ask for input (a usage limit or an approval) and nobody can answer it";
        await session.cancel();
      } else if (event.type === "turn.settled") {
        const error = data.error as { code?: string; message?: string } | undefined;
        if (data.outcome === "completed") result.ok = true;
        else if (error?.code === "OUTPUT_SCHEMA_NOT_FULFILLED" && replyText.trim().startsWith("{")) {
          // The model answered in text instead of through the reply tool: core settles it against the schema.
          result.ok = true;
          result.text = replyText;
        } else if (capped && !result.error) {
          result.error = `no answer the ${pack.id} schema accepts within ${input.limits.maxTurns} model calls`;
        } else if (!result.error) {
          result.error = error?.message ? `${error.code ?? "error"}: ${error.message}` : (failure ?? String(data.outcome));
        }
      }
    }
    result.turns = modelCalls;
  } catch (e) {
    result.ok = false;
    result.error = e instanceof Error ? e.message : String(e);
  } finally {
    await stop(server);
    bridge.server.close();
    rmSync(state, { recursive: true, force: true });
    rmSync(dirname(secretsFile), { recursive: true, force: true });
  }
  if (result.error && /\b429\b|too many requests/i.test(result.error)) result.rateLimited = true;
  if (!result.ok && result.structured) result.structured = null;
  result.durationMs = Date.now() - t0;
  return result;
}

/** Waits for the server to answer its health check; fails with its log when it exits or never does. */
async function waitHealthy(health: () => Promise<{ ok: boolean }>, server: ChildProcess, log: string[]): Promise<void> {
  const deadline = Date.now() + HEALTHY_WITHIN_MS;
  while (Date.now() < deadline && server.exitCode === null) {
    try {
      if ((await health()).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`the eve server never became healthy:\n${log.slice(-20).join("\n")}`);
}

async function stop(server: ChildProcess): Promise<void> {
  if (server.exitCode !== null) return;
  const exited = new Promise((r) => server.once("exit", r));
  server.kill("SIGTERM");
  const timer = setTimeout(() => server.kill("SIGKILL"), 3_000);
  await exited;
  clearTimeout(timer);
}

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const { port } = probe.address() as AddressInfo;
  await new Promise((r) => probe.close(r));
  return port;
}

const body = async (req: IncomingMessage): Promise<unknown> => {
  let text = "";
  for await (const chunk of req) text += String(chunk);
  return text ? JSON.parse(text) : {};
};

/** Whether a request carries the run's token, compared in constant time. */
const sha = (text: string) => createHash("sha256").update(text).digest();
const carries = (req: IncomingMessage, token: string): boolean => timingSafeEqual(sha(req.headers.authorization ?? ""), sha(`Bearer ${token}`));

/** The luna tools over loopback: POST /<tool> with the run's bearer token, the input as JSON. */
export async function serveLuna(call: RunContext["luna"]["call"], token: string): Promise<{ server: Server; url: string }> {
  const server = createServer(async (req, res) => {
    const reply = (status: number, value: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (req.method !== "POST" || !carries(req, token)) return reply(403, { error: "forbidden" });
    try {
      reply(200, await call((req.url ?? "/").slice(1), await body(req)));
    } catch (e) {
      reply(400, { error: e instanceof Error ? e.message : String(e) });
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}
