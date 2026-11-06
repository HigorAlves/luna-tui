// The eve runtime: one stage through Vercel's eve, for every engine that is not a Claude model.
// The pack's agent was compiled and built at image time (compile.ts, build.ts); a run starts that
// built server on loopback with a per-run password, its working directory on the /tmp tmpfs (eve
// keeps its workflow store under <cwd>/.eve), sends the prompt with the pack's answer schema
// through eve/client, and follows the session's events into run events, the tool approvals' outcome
// included. The luna tools' state stays here: the agent's luna tools call back into
// this process over a loopback bridge with a per-run bearer token. The server always stops.
// LUNA_STAGE_DEBUG=1 also writes every session event to /out/raw.jsonl and the server's log to
// /out/eve-server.log.
import { eveTokens, sumTokens } from "../../core/usage.ts";
import { ENGINES, type Pack, answerJsonSchema, lowestBar } from "@hardness/contracts";
import type { SendTurnOptions } from "eve/client";
import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { appendFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { type IncomingMessage, type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { decisionSummary, renderDecision, stateOf } from "../../core/decide.ts";
import { CallJoin, type Emit } from "../../core/events.ts";
import { type GuardContext, branchPrefixFor } from "../../core/guards.ts";
import { EMPTY_RUN, type RunOutcome, budgetSpent, timeRanOut } from "../../core/output.ts";
import { type Instructions, NO_INSTRUCTIONS, type RunContext, type Runtime, deadlineMs } from "../../core/runtime.ts";
import { DELEGATE, delegatedHelpers } from "../../core/delegate.ts";
import { GRAPH_BRANCH_ROOT, GRAPH_ROOT } from "../../core/roots.ts";
import { GUARDED, appName, eveTools, instructionParts, tokenBudgetPerTurn } from "./compile.ts";
import type { EveSecrets } from "./agent/secrets.ts";

const env = process.env;
const HEALTHY_WITHIN_MS = 30_000;
/** How long a cancelled turn may take to settle before the run stops following it. */
const CANCEL_GRACE_MS = 5_000;

export interface EveOptions {
  /** Where the built agents are, one folder per pack (default <factory>/.eve-agents). */
  agentsDir?: string;
  /** Extra environment for the server (the conformance fake's script). */
  serverEnv?: Record<string, string>;
}

/** The eve runtime over the agents in `options.agentsDir`. */
export function eveRuntime(options: EveOptions = {}): Runtime {
  return { id: "eve", sdk: "eve", instructions, run: (ctx) => run(ctx, options) };
}

/** The agent's instructions.md as compile.ts writes it, and the skills it copies in. */
function instructions(pack: Pack, factoryRoot: string): Instructions {
  if (pack.kind !== "agent" || pack.agent === null) return NO_INSTRUCTIONS;
  const { body, rules, addendum } = instructionParts(pack, factoryRoot);
  return { role: `${body}\n${addendum}`, rules, skills: pack.access.skills ? pack.skills : [] };
}

export const eve: Runtime = eveRuntime();

/** The stage's guard policy, as the agent's tools read it from LUNA_EVE_GUARD. */
export function guardPolicy(pack: Pack, { input, paths }: RunContext): GuardContext {
  // A decision pack has no tools: with no commands, no web and nothing to write, every guarded call is refused.
  const access = pack.kind === "agent" ? pack.access : null;
  return {
    writable: pack.writable,
    branch: input.task.branch || null,
    branchPrefix: branchPrefixFor(input.task),
    workRoot: paths.work,
    outRoot: paths.out,
    // eve's bash has no allow-list of its own: the pack's commands are enforced by the guard.
    commands: access?.commands ?? [],
    // The model's tools run as the same user as Codex and the runner: only the run's own roots
    // may be named, never the Codex home, HOME, /proc or the secrets file.
    roots: { scratch: paths.scratch, read: [paths.input, GRAPH_ROOT, GRAPH_BRANCH_ROOT] },
    web: access?.web ?? false,
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
  const { pack, engine, input, prompt, paths, luna, dry, emit } = ctx;
  if (pack.kind === "agent" && pack.agent === null) return { ...EMPTY_RUN, error: `pack ${pack.id} has no agent to run` };
  // A decision pack is one turn: the questions as the message, the answer schema as the output schema.
  const decision = pack.kind === "decision" ? pack : null;
  const message = decision ? renderDecision(decision.questions, stateOf(input)) : prompt;
  const maxTurns = decision ? 1 : input.limits.maxTurns;
  const app = join(options.agentsDir ?? join(paths.factoryRoot, ".eve-agents"), appName(pack));
  const entry = join(app, ".output", "server", "index.mjs");
  const apiKey = (ENGINES[engine.id] as { auth?: string }).auth === "api-key";
  const guard = guardPolicy(pack, ctx);

  if (dry) {
    const options = {
      agent: app,
      built: existsSync(entry),
      model: `${apiKey ? "openai" : "chatgpt"}(${engine.modelId})`,
      reasoning: pack.kind === "agent" ? pack.effort : "low",
      tools: pack.kind === "agent" ? [...eveTools(pack.access), ...(delegatedHelpers(pack, "eve").length > 0 ? [DELEGATE] : [])] : [],
      skills: pack.kind === "agent" && pack.access.skills ? pack.skills : [],
      maxModelCalls: maxTurns,
      tokenBudget: { input: maxTurns * tokenBudgetPerTurn.input, output: maxTurns * tokenBudgetPerTurn.output },
      outputSchema: pack.id,
      guard,
    };
    emit({ kind: "session", payload: { model: engine.modelId, text: JSON.stringify(options, null, 2) } });
    let structured: Record<string, unknown> | null = null;
    try {
      structured = env.LUNA_STAGE_DRY_STRUCTURED ? (JSON.parse(env.LUNA_STAGE_DRY_STRUCTURED) as Record<string, unknown>) : null; // test seam
    } catch {}
    return { ...EMPTY_RUN, ok: true, structured, text: "dry-run" };
  }
  if (!existsSync(entry)) {
    return { ...EMPTY_RUN, error: `the eve agent for ${appName(pack)} is not built (${app}): the runner image builds one for each pack whose engines allow eve, and for each helper on an eve engine (node src/runtimes/eve/build.ts)` };
  }

  const t0 = Date.now();
  // The pinned ID the server was given; eve's model.started names the agent's compiled default
  // for a model chosen at run time, so it is not read back.
  const turn = new TurnFollower(pack, maxTurns, emit, engine.modelId);
  turn.result.model = engine.modelId;
  const debug = env.LUNA_STAGE_DEBUG === "1";
  // Everything the run makes is made inside the try, so a throw anywhere still stops the server,
  // closes the bridge and removes the run's folders.
  let bridge: Server | null = null;
  let server: ChildProcess | null = null;
  let secretsFile: string | null = null;
  let state: string | null = null;
  let timedOut: number | null = null;
  try {
    const bridgeToken = randomBytes(24).toString("hex");
    const served = await serveLuna(luna.call, bridgeToken);
    bridge = served.server;
    const password = randomBytes(24).toString("hex");
    const ghToken = env.GH_TOKEN || env.GITHUB_TOKEN || undefined;
    secretsFile = writeSecrets({ password, bridgeToken, ...(ghToken && { ghToken }), ...(apiKey && env.OPENAI_API_KEY && { openaiApiKey: env.OPENAI_API_KEY }) });
    const port = await freePort();
    state = mkdtempSync(join(tmpdir(), "eve-"));
    const log: string[] = [];
    server = spawn(process.execPath, [entry], {
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
        // The compiled token budget (compile.ts) scales with the turns this run was given.
        LUNA_EVE_MAX_TURNS: String(maxTurns),
        LUNA_EVE_WORKSPACE: paths.work,
        LUNA_EVE_SCRATCH: paths.scratch,
        LUNA_EVE_GUARD: JSON.stringify(guard),
        LUNA_EVE_BRIDGE_URL: served.url,
        // Laminar's key for agent/laminar.ts; its address (LMNR_BASE_URL, LMNR_GRPC_PORT) passes through serverEnv as it is.
        ...(env.LMNR_PROJECT_API_KEY ? { LMNR_PROJECT_API_KEY: env.LMNR_PROJECT_API_KEY } : {}),
      }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const keep = (b: Buffer) => {
      if (debug) appendFileSync(join(paths.out, "eve-server.log"), b);
      log.push(...String(b).split("\n").filter(Boolean));
      log.splice(0, Math.max(0, log.length - 50));
    };
    server.stdout?.on("data", keep);
    server.stderr?.on("data", keep);

    const { Client } = await import("eve/client");
    const client = new Client({ baseUrl: `http://127.0.0.1:${port}`, auth: { basic: { username: "stage", password } } });
    await waitHealthy(() => client.health(), server, log);
    // The pack's schema is plain JSON Schema; eve types it as its own JSON object.
    const outputSchema = answerJsonSchema(pack) as SendTurnOptions["outputSchema"];
    const { session, delivery } = await client.sessions.create({ message, outputSchema });
    turn.result.sessionId = session.id;
    emit({ kind: "session", payload: { id: session.id, model: engine.modelId, text: `session ${session.id} · eve agent ${appName(pack)} · ${apiKey ? "openai" : "chatgpt"}(${engine.modelId})` } });
    // The stage ends itself at its deadline, before the machine kills the container: the turn is
    // cancelled, and if the server does not settle it soon after, the run stops following it.
    const deadline = deadlineMs(input.limits.timeoutMs);
    let expire: (value: { done: true; value: undefined }) => void = () => {};
    const expired = new Promise<{ done: true; value: undefined }>((resolve) => (expire = resolve));
    const timer = setTimeout(() => {
      timedOut = deadline;
      session.cancel().catch(() => {});
      setTimeout(() => expire({ done: true, value: undefined }), CANCEL_GRACE_MS).unref();
    }, deadline);
    try {
      const events = delivery.stream()[Symbol.asyncIterator]();
      for (;;) {
        const next = await Promise.race([events.next(), expired]);
        if (next.done) break;
        if (debug) appendFileSync(join(paths.out, "raw.jsonl"), `${JSON.stringify(next.value)}\n`);
        if (turn.take(next.value as unknown as SessionEvent)) await session.cancel();
      }
    } finally {
      clearTimeout(timer);
      expire({ done: true, value: undefined });
    }
  } catch (e) {
    turn.result.ok = false;
    turn.result.structured = null;
    turn.result.error = e instanceof Error ? e.message : String(e);
    if (/\b429\b|too many requests/i.test(turn.result.error)) turn.result.rateLimited = true;
  } finally {
    if (timedOut !== null && !turn.result.ok) Object.assign(turn.result, { structured: null, rateLimited: false, error: timeRanOut(timedOut) });
    turn.calls.flush();
    if (server) await stop(server);
    bridge?.close();
    if (state) rmSync(state, { recursive: true, force: true });
    if (secretsFile) rmSync(dirname(secretsFile), { recursive: true, force: true });
  }
  turn.result.durationMs = Date.now() - t0;
  if (decision && turn.result.structured) emit({ kind: "text", payload: { text: decisionSummary(decision.questions, turn.result.structured, lowestBar(decision.policy)) } });
  return turn.result;
}

/** One session event as the follower reads it. */
interface SessionEvent {
  type: string;
  data?: Record<string, unknown>;
}

/** Follows one turn's session events into the run's outcome and its events, and says when
 *  the turn must be cancelled: when the run's last allowed model call settles without an answer
 *  (eve retries an answer off the schema without a limit of its own), or when the turn pauses
 *  for input nobody can give. */
export class TurnFollower {
  readonly result: RunOutcome = { ...EMPTY_RUN };
  /** The tool calls: a guarded one is emitted once its approval settled, the rest when requested. */
  readonly calls: CallJoin;
  private readonly runs = new Set<string>();
  private modelCalls = 0;
  private capped = false;
  private paused = false;
  private replyText = "";
  private failure: string | null = null;

  private readonly pack: Pick<Pack, "id" | "answer">;
  private readonly maxTurns: number;
  private readonly emit: Emit;
  private readonly model: string;

  constructor(pack: Pick<Pack, "id" | "answer">, maxTurns: number, emit: Emit, model = "") {
    this.pack = pack;
    this.maxTurns = maxTurns;
    this.emit = emit;
    this.model = model;
    this.calls = new CallJoin(emit, (tool) => GUARDED.has(tool));
  }

  /** Takes one event; true when the turn must be cancelled now. */
  take(event: SessionEvent): boolean {
    const data = event.data ?? {};
    const result = this.result;
    if (event.type === "model.requested" && (data.owner as { turnId?: string } | undefined)?.turnId) {
      this.modelCalls++;
      this.runs.add(String(data.runId));
      result.turns = this.modelCalls;
      // A call past the cap that started before the cancel landed.
      return this.cap(this.modelCalls > this.maxTurns);
    }
    if (event.type === "model.settled" && data.error) {
      // A model error eve will not retry ends the session and cancels the turn: keep its reason.
      const error = data.error as { code?: string; message?: string };
      this.failure = `${error.code ?? "error"}: ${error.message ?? ""}`;
      return false;
    }
    if (event.type === "model.settled") return this.cap(this.runs.has(String(data.runId)) && this.modelCalls >= this.maxTurns && result.structured === null);
    if (event.type === "session.ended" && data.error) {
      const error = data.error as { code?: string; message?: string };
      this.failure = `${error.code ?? "error"}: ${error.message ?? ""}`;
    } else if (event.type === "content.completed") {
      if (data.kind === "result") result.structured = data.value as Record<string, unknown>;
      else if (data.kind === "text" && typeof data.value === "string") {
        this.emit({ kind: "text", payload: { text: data.value } });
        if (data.phase === "reply") this.replyText = data.value;
      }
    } else if (event.type === "call.requested") {
      this.calls.requested(String(data.callId), (data.capability as { name?: string } | undefined)?.name ?? "tool", data.input ?? {});
    } else if (event.type === "call.started") {
      // The call cleared its approval (or needed none): the guard allowed it.
      this.calls.decided(String(data.callId), "", {}, { allow: true });
    } else if (event.type === "call.settled") {
      const id = String(data.callId);
      const error = data.error as { message?: string } | undefined;
      // A rejected call never started: in a stage nobody approves by hand, so the guard refused it.
      if (data.outcome === "rejected") this.calls.decided(id, "", {}, { allow: false, reason: error?.message ?? "rejected" });
      const ok = data.outcome === "completed";
      this.calls.settled(id, ok, ok ? undefined : `${String(data.outcome)}: ${error?.message ?? ""}`);
    } else if (event.type === "usage.recorded") {
      const usage = data.usage as { costUsd?: number; inputTokens?: number; outputTokens?: number; cacheReadTokens?: number } | undefined;
      if (typeof usage?.costUsd === "number") result.costUsd = (result.costUsd ?? 0) + usage.costUsd;
      result.tokens = sumTokens(result.tokens, eveTokens(usage));
      this.emit({
        kind: "usage",
        payload: {
          model: this.model,
          ...(typeof usage?.inputTokens === "number" && { inputTokens: usage.inputTokens }),
          ...(typeof usage?.outputTokens === "number" && { outputTokens: usage.outputTokens }),
          ...(typeof usage?.costUsd === "number" && { costUsd: usage.costUsd }),
        },
      });
    } else if (event.type === "turn.paused" && !this.capped) {
      // eve asks to continue past the pack's compiled token budget (approvals never ask here):
      // nobody is here to answer, and no provider reset would resume it.
      this.paused = true;
      return this.cap(true);
    } else if (event.type === "turn.settled") {
      this.settle(data.outcome, data.error as { code?: string; message?: string } | undefined);
    }
    return false;
  }

  /** Marks the turn capped the first time `when` holds; true then, so the caller cancels once. */
  private cap(when: boolean): boolean {
    if (!when || this.capped) return false;
    this.capped = true;
    return true;
  }

  private settle(outcome: unknown, error: { code?: string; message?: string } | undefined): void {
    const result = this.result;
    if (outcome === "completed" && result.structured !== null) {
      result.ok = true;
      return;
    }
    // The model may have answered in text instead of through the reply tool: taken only when the
    // text is an answer the pack's schema accepts, never on the strength of a leading brace.
    const fromText = this.answerFromText();
    if (fromText !== null) {
      Object.assign(result, { ok: true, structured: fromText, text: this.replyText, error: null });
      return;
    }
    result.ok = false;
    result.structured = null;
    if (this.paused || error?.code === "SESSION_USAGE_LIMIT_REACHED") result.error = budgetSpent(`its token budget for ${this.maxTurns} turns ran out before an answer`);
    else if (this.capped) result.error = `no answer the ${this.pack.id} schema accepts within ${this.maxTurns} model calls`;
    else result.error = error?.message ? `${error.code ?? "error"}: ${error.message}` : (this.failure ?? String(outcome));
    if (/\b429\b|too many requests/i.test(`${result.error} ${this.failure ?? ""}`)) result.rateLimited = true;
  }

  private answerFromText(): Record<string, unknown> | null {
    try {
      const parsed = this.pack.answer.safeParse(JSON.parse(this.replyText));
      return parsed.success ? (parsed.data as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
}

/** Waits for the server to answer its health check; fails with its log as soon as it exits (by
 *  a code or a signal) or when it never does. */
export async function waitHealthy(health: () => Promise<{ ok: boolean }>, server: ChildProcess, log: string[]): Promise<void> {
  const deadline = Date.now() + HEALTHY_WITHIN_MS;
  const exited = () => server.exitCode !== null || server.signalCode !== null;
  let died = exited();
  const onExit = () => {
    died = true;
  };
  server.once("exit", onExit);
  try {
    while (Date.now() < deadline && !died) {
      try {
        if ((await health()).ok) return;
      } catch {}
      await new Promise((r) => setTimeout(r, 50));
    }
  } finally {
    server.off("exit", onExit);
  }
  throw new Error(`the eve server never became healthy:\n${log.slice(-20).join("\n")}`);
}

/** Stops the server: at once when it already exited, by a code or a signal; else SIGTERM, then
 *  SIGKILL after 3 s. */
export async function stop(server: ChildProcess): Promise<void> {
  if (server.exitCode !== null || server.signalCode !== null) return;
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
