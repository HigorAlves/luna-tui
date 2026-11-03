// The Claude runtime: one stage through the Claude Agent SDK. The pack becomes the SDK options
// (its role as `agent`, its helpers as `agents`, the plugin's skills, its access as tool lists, the
// guards as PreToolUse hooks, the luna tools as an in-process MCP server) and `query()` is
// followed to its result, its messages and the hooks' decisions turned into run events as it goes.
import type { Options, Query } from "@anthropic-ai/claude-agent-sdk";
import { answerJsonSchema } from "@hardness/contracts";
import { appendFileSync } from "node:fs";
import { join } from "node:path";

import { CallJoin } from "../../core/events.ts";
import type { GuardContext } from "../../core/guards.ts";

import { EMPTY_RUN, type RunOutcome, timeRanOut } from "../../core/output.ts";
import { FACTORY_RULES } from "../../core/render.ts";
import { type RunContext, type Runtime, deadlineMs } from "../../core/runtime.ts";
import { claudeTools } from "./access.ts";
import { agentDefinitions } from "./agents.ts";
import { branchPrefixFor, isGuarded, preToolUseGuards } from "./guards.ts";
import { lunaServer } from "./luna.ts";

const env = process.env;

/** The SDK's `query()`, or a stand-in with its signature (the conformance table's scripted fake). */
export type Transport = (params: { prompt: string; options?: Options }) => Query;

/** The Claude runtime on `transport`; without one, on the SDK's own `query()`. */
export function claudeRuntime(transport?: Transport): Runtime {
  return { id: "claude", run: (ctx) => run(ctx, transport) };
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
    roots: { scratch: paths.scratch, read: [paths.input, join(paths.factoryRoot, "plugin")] },
    web: pack.kind === "agent" && pack.access.web,
    // e2e signs in with the credentials its targets name (`env:QA_PASSWORD`), inline as "$QA_PASSWORD".
    expandable: (input.context.qaTargets ?? []).flatMap((t) => (t.credential?.startsWith("env:") ? [t.credential.slice(4)] : [])),
  };
}

async function run(ctx: RunContext, transport?: Transport): Promise<RunOutcome> {
  const { pack, engine, input, prompt, paths, luna, dry, emit } = ctx;
  if (pack.kind !== "agent" || pack.agent === null) return { ...EMPTY_RUN, error: `pack ${pack.id} has no agent to run` };
  // A call's event joins the stream's tool_use and the hook's decision, whichever comes first.
  const calls = new CallJoin(emit, isGuarded);
  const options = {
    cwd: paths.work,
    agent: pack.agent,
    agents: agentDefinitions(pack, join(paths.factoryRoot, "roles"), engine.modelId),
    systemPrompt: { type: "preset" as const, preset: "claude_code" as const, append: FACTORY_RULES },
    plugins: [{ type: "local" as const, path: join(paths.factoryRoot, "plugin") }],
    settingSources: [] as [],
    ...claudeTools(pack.access),
    permissionMode: "dontAsk" as const,
    maxTurns: input.limits.maxTurns,
    outputFormat: { type: "json_schema" as const, schema: answerJsonSchema(pack) },
    mcpServers: { luna: lunaServer(luna.call) },
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
    emit({ kind: "session", payload: { model: engine.modelId, text: JSON.stringify({ ...printable, agents: Object.keys(agents), hooks: ["PreToolUse"], mcpServers: ["luna"] }, null, 2) } });
    let structured: Record<string, unknown> | null = null;
    try {
      structured = env.LUNA_STAGE_DRY_STRUCTURED ? (JSON.parse(env.LUNA_STAGE_DRY_STRUCTURED) as Record<string, unknown>) : null; // test seam
    } catch {}
    return { ...EMPTY_RUN, ok: true, structured, text: "dry-run" };
  }

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
    const query = transport ?? (await import("@anthropic-ai/claude-agent-sdk")).query;
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
