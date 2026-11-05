// The Claude runtime: one stage through the Claude Agent SDK. The pack becomes the SDK options
// (its role as `agent`, its helpers as `agents`, the plugin's skills, its access as tool lists, the
// guards as PreToolUse hooks, the luna tools as an in-process MCP server) and `query()` is
// followed to its result, its messages and the hooks' decisions turned into run events as it goes.
import type { Options, Query } from "@anthropic-ai/claude-agent-sdk";
import { type Pack, answerJsonSchema, lowestBar } from "@hardness/contracts";
import { appendFileSync } from "node:fs";
import { join } from "node:path";

import { decisionSummary, renderDecision, stateOf } from "../../core/decide.ts";
import { DELEGATE } from "../../core/delegate.ts";
import { CallJoin } from "../../core/events.ts";
import type { GuardContext } from "../../core/guards.ts";
import { GRAPH_ROOT } from "../../core/roots.ts";

import { EMPTY_RUN, type RunOutcome, timeRanOut } from "../../core/output.ts";
import { FACTORY_RULES } from "../../core/render.ts";
import { NO_TELEMETRY } from "../../core/telemetry.ts";
import { type Instructions, NO_INSTRUCTIONS, type RunContext, type Runtime, deadlineMs } from "../../core/runtime.ts";
import { claudeTools } from "./access.ts";
import { PLUGIN_NAME, agentDefinitions } from "./agents.ts";
import { branchPrefixFor, isGuarded, preToolUseGuards } from "./guards.ts";
import { lunaServer } from "./luna.ts";

const env = process.env;

/** The SDK's `query()`, or a stand-in with its signature (the conformance table's scripted fake). */
export type Transport = (params: { prompt: string; options?: Options }) => Query;

/** The Claude runtime on `transport`; without one, on the SDK's own `query()`. */
export function claudeRuntime(transport?: Transport): Runtime {
  return { id: "claude", sdk: "@anthropic-ai/claude-agent-sdk", instructions, run: (ctx) => run(ctx, transport) };
}

/** The role and its helpers as their definitions carry them, the rules the system prompt appends,
 *  and every skill a definition names. */
function instructions(pack: Pack, factoryRoot: string): Instructions {
  if (pack.kind !== "agent" || pack.agent === null) return NO_INSTRUCTIONS;
  const definitions = Object.entries(agentDefinitions(pack, join(factoryRoot, "roles"), ""));
  return {
    role: definitions.map(([name, d]) => `${name}\n${d.prompt}`).join("\n\n"),
    rules: FACTORY_RULES,
    skills: definitions.flatMap(([, d]) => d.skills ?? []).map((skill) => skill.replace(`${PLUGIN_NAME}:`, "")),
  };
}

export const claude: Runtime = claudeRuntime();

/** The stage's guard policy: the pack's write access and branch, and the roots every path a tool
 *  names must lie in. The skills' own files are read-only roots, as is the stage input. */
export function guardPolicy({ pack, input, paths }: Pick<RunContext, "pack" | "input" | "paths">): GuardContext {
  return {
    writable: pack.writable,
    branch: input.task.branch || null,
    // A PR task commits on the PR's own branch, not a task/ branch.
    branchPrefix: branchPrefixFor(input.task),
    workRoot: paths.work,
    outRoot: paths.out,
    roots: { scratch: paths.scratch, read: [paths.input, join(paths.factoryRoot, "plugin"), GRAPH_ROOT] },
    web: pack.kind === "agent" && pack.access.web,
    // e2e signs in with the credentials its targets name (`env:QA_PASSWORD`), inline as "$QA_PASSWORD".
    expandable: (input.context.qaTargets ?? []).flatMap((t) => (t.credential?.startsWith("env:") ? [t.credential.slice(4)] : [])),
  };
}

async function run(ctx: RunContext, transport?: Transport): Promise<RunOutcome> {
  const { pack, engine, input, prompt, paths, luna, dry, emit } = ctx;
  if (pack.kind === "decision") return decide(ctx, transport);
  if (pack.kind !== "agent" || pack.agent === null) return { ...EMPTY_RUN, error: `pack ${pack.id} has no agent to run` };
  // A call's event joins the stream's tool_use and the hook's decision, whichever comes first.
  const calls = new CallJoin(emit, isGuarded);
  // `delegate` rides on the luna server when the pack hands work to a helper on another runtime.
  const { tools, allowedTools } = claudeTools(pack.access);
  const delegating = ctx.delegate ? [`mcp__luna__${DELEGATE}`] : [];
  const options = {
    cwd: paths.work,
    agent: pack.agent,
    agents: agentDefinitions(pack, join(paths.factoryRoot, "roles"), engine.modelId),
    systemPrompt: { type: "preset" as const, preset: "claude_code" as const, append: FACTORY_RULES },
    plugins: [{ type: "local" as const, path: join(paths.factoryRoot, "plugin") }],
    settingSources: [] as [],
    tools: [...tools, ...delegating],
    allowedTools: [...allowedTools, ...delegating],
    permissionMode: "dontAsk" as const,
    maxTurns: input.limits.maxTurns,
    outputFormat: { type: "json_schema" as const, schema: answerJsonSchema(pack) },
    mcpServers: { luna: lunaServer(luna.call, ctx.delegate ?? null) },
    hooks: {
      PreToolUse: preToolUseGuards(guardPolicy(ctx), (id, tool, toolInput, decision) => calls.decided(id, tool, toolInput, decision)),
    },
    // The pinned ID, never an alias: the model does not change under the stage between runs.
    model: engine.modelId,
    effort: pack.effort,
    // The scratch folder is the model's TMPDIR: the one place outside /work and /out it may write.
    env: { ...env, LUNA_FACTORY: "1", TMPDIR: paths.scratch },
  };

  if (dry) {
    const { mcpServers: _m, hooks: _h, env: _e, agents, ...printable } = options;
    return dryRun(ctx, JSON.stringify({ ...printable, agents: Object.keys(agents), hooks: ["PreToolUse"], mcpServers: ["luna"] }, null, 2));
  }

  return drive(ctx, transport, prompt, options, calls);
}

/** Turns a decision may take on Claude. The answer is one model call, but the SDK delivers a
 *  structured output through its own tool turn, so a cap of one ends the run before the JSON
 *  arrives (seen on the triage_signals evals: "Reached maximum number of turns (1)"); the third
 *  turn is slack for one retry after a schema error. The pack's own limit stays 1: its turns are
 *  model calls, and the eval scorecard counts those. */
const DECIDE_TURNS = 3;

/** A decision pack on Claude: one answer, no tools, no agent, the questions as the prompt and the
 *  answer schema as the structured output. Confidence is self-reported; calibration is the eval's job. */
async function decide(ctx: RunContext, transport?: Transport): Promise<RunOutcome> {
  const { pack, engine, input, dry, emit } = ctx;
  if (pack.kind !== "decision") throw new Error(`decide() called for ${pack.id}`);
  const options: Options = {
    systemPrompt: "You answer typed questions about a software ticket for an automated pipeline. Be calibrated and terse.",
    tools: [],
    allowedTools: [],
    permissionMode: "dontAsk",
    maxTurns: DECIDE_TURNS,
    outputFormat: { type: "json_schema", schema: answerJsonSchema(pack) },
    model: engine.modelId,
    effort: "low",
    settingSources: [],
    env: { ...env, LUNA_FACTORY: "1" },
  };
  if (dry) return dryRun(ctx, JSON.stringify({ ...options, env: undefined }, null, 2));
  const prompt = renderDecision(pack.questions, stateOf(input));
  const run = await drive(ctx, transport, prompt, options, new CallJoin(emit, isGuarded));
  if (run.structured) emit({ kind: "text", payload: { text: decisionSummary(pack.questions, run.structured, lowestBar(pack.policy)) } });
  return run;
}

/** A dry run: what would be sent, printed, and the answer the test seam gives, if it gives one. */
function dryRun({ engine, emit }: RunContext, printed: string): RunOutcome {
  emit({ kind: "session", payload: { model: engine.modelId, text: printed } });
  let structured: Record<string, unknown> | null = null;
  try {
    structured = env.LUNA_STAGE_DRY_STRUCTURED ? (JSON.parse(env.LUNA_STAGE_DRY_STRUCTURED) as Record<string, unknown>) : null; // test seam
  } catch {}
  return { ...EMPTY_RUN, ok: true, structured, text: "dry-run" };
}

/** Follows `query()` to its result: the messages become run events, and the deadline ends the run cleanly. */
async function drive(ctx: RunContext, transport: Transport | undefined, prompt: string, options: Options, calls: CallJoin): Promise<RunOutcome> {
  const { engine, input, paths, emit } = ctx;
  const t0 = Date.now();
  const run: RunOutcome = { ...EMPTY_RUN };
  // The stage ends itself at its deadline, before the machine kills the container.
  const abortController = new AbortController();
  const deadline = deadlineMs(input.limits.timeoutMs);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    abortController.abort();
  }, deadline);
  try {
    // Laminar's Claude Agent SDK integration: every turn, tool call and subagent as a span, when on.
    const query = (ctx.telemetry ?? NO_TELEMETRY).wrapQuery(transport ?? (await import("@anthropic-ai/claude-agent-sdk")).query);
    const raw = env.LUNA_STAGE_DEBUG === "1" ? join(paths.out, "raw.jsonl") : null;
    for await (const msg of query({ prompt, options: { ...options, abortController } })) {
      if (raw) appendFileSync(raw, `${JSON.stringify(msg)}\n`);
      if ("session_id" in msg && typeof msg.session_id === "string" && !run.sessionId) run.sessionId = msg.session_id;
      if (msg.type === "system" && msg.subtype === "init") {
        run.model = msg.model;
        const text = `session ${msg.session_id} · model ${msg.model} · skills ${msg.skills.length} · plugins ${msg.plugins.map((p) => p.name).join(",") || "none"}`;
        emit({ kind: "session", payload: { id: msg.session_id, model: msg.model, text } });
      } else if (msg.type === "assistant") {
        for (const block of msg.message?.content ?? []) {
          if (block.type === "text" && block.text) emit({ kind: "text", payload: { text: block.text } });
          else if (block.type === "tool_use") calls.requested(block.id, block.name, block.input);
        }
      } else if (msg.type === "user" && Array.isArray(msg.message?.content)) {
        // A call's result, without its output: the transcript has never shown it.
        for (const block of msg.message.content) if (block.type === "tool_result") calls.settled(block.tool_use_id, block.is_error !== true);
      } else if (msg.type === "rate_limit_event") {
        const info = msg.rate_limit_info;
        if (info.status === "rejected") {
          run.rateLimited = true;
          run.resetsAt = info.resetsAt ?? null;
        }
      } else if (msg.type === "result") {
        run.ok = msg.subtype === "success" && !msg.is_error;
        run.structured = msg.subtype === "success" && msg.structured_output && typeof msg.structured_output === "object" ? (msg.structured_output as Record<string, unknown>) : null;
        run.text = msg.subtype === "success" && typeof msg.result === "string" ? msg.result : "";
        run.turns = msg.num_turns ?? 0;
        run.costUsd = msg.total_cost_usd ?? null;
        run.durationMs = msg.duration_ms ?? 0;
        const usage = msg.usage as { input_tokens?: number; output_tokens?: number } | undefined;
        run.tokens = typeof usage?.input_tokens === "number" && typeof usage.output_tokens === "number" ? { input: usage.input_tokens, output: usage.output_tokens } : null;
        emit({
          kind: "usage",
          payload: { model: run.model || engine.modelId, ...(usage?.input_tokens !== undefined && { inputTokens: usage.input_tokens }), ...(usage?.output_tokens !== undefined && { outputTokens: usage.output_tokens }), ...(run.costUsd !== null && { costUsd: run.costUsd }) },
        });
        if (!run.ok) {
          const errors = "errors" in msg && Array.isArray(msg.errors) ? msg.errors.join("; ") : "";
          run.error = errors || (msg.subtype === "success" ? msg.result : msg.subtype) || "error";
        }
      }
    }
  } catch (e) {
    run.ok = false;
    run.error = e instanceof Error ? e.message : String(e);
  } finally {
    clearTimeout(timer);
    calls.flush();
  }
  if (timedOut && !run.ok) Object.assign(run, { structured: null, rateLimited: false, error: timeRanOut(deadline) });
  if (!run.durationMs) run.durationMs = Date.now() - t0;
  return run;
}
