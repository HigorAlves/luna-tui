// A scripted query() for the conformance table: it plays a script the way the Agent SDK would run
// it, through the options the runtime built. A tool call runs the runtime's PreToolUse hooks for
// that tool and, when they allow it, the luna server's handler; a denial's reason is what the
// model reads next, as the SDK reports it. No model and no subprocess.
import type { HookCallbackMatcher, HookJSONOutput, Options, Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import type { ScriptStep } from "../conformance/table.ts";

type RegisteredTools = Record<string, { handler: (args: unknown, extra: unknown) => Promise<{ content: Array<{ text: string }> }> }>;

const SESSION = "fake-session";

/** The tool the SDK would name for a scripted call, and its input. */
function toolUse(step: Extract<ScriptStep, { call: string }>): { name: string; input: Record<string, unknown> } {
  return step.call === "bash" ? { name: "Bash", input: { command: step.command } } : { name: `mcp__luna__${step.tool}`, input: step.args };
}

/** What the model reads back from one call: the hooks' denial, or what the tool returned. */
async function execute(options: Options, name: string, input: Record<string, unknown>, id: string): Promise<string> {
  const matchers: HookCallbackMatcher[] = options.hooks?.PreToolUse ?? [];
  for (const matcher of matchers.filter((m) => new RegExp(m.matcher ?? ".*").test(name))) {
    for (const hook of matcher.hooks) {
      const decision = (await hook({ hook_event_name: "PreToolUse", tool_name: name, tool_input: input, tool_use_id: id, session_id: SESSION, transcript_path: "", cwd: options.cwd ?? "" } as never, id, { signal: new AbortController().signal })) as HookJSONOutput;
      const specific = "hookSpecificOutput" in decision ? (decision.hookSpecificOutput as { permissionDecision?: string; permissionDecisionReason?: string } | undefined) : undefined;
      if (specific?.permissionDecision === "deny") return specific.permissionDecisionReason ?? "denied";
    }
  }
  if (name.startsWith("mcp__luna__")) {
    const server = options.mcpServers?.luna as { instance?: { _registeredTools?: RegisteredTools } } | undefined;
    const tool = server?.instance?._registeredTools?.[name.slice("mcp__luna__".length)];
    if (!tool) return `no tool ${name}`;
    return (await tool.handler(input, {})).content[0]?.text ?? "";
  }
  return "(ran)";
}

export function scriptedQuery(script: ScriptStep[]): (params: { prompt: string; options?: Options }) => Query {
  return ({ options = {} }) => {
    async function* play(): AsyncGenerator<SDKMessage, void> {
      yield { type: "system", subtype: "init", session_id: SESSION, model: options.model ?? "", skills: [], plugins: [] } as unknown as SDKMessage;
      let last = "";
      let turns = 0;
      for (const step of script) {
        turns++;
        if ("call" in step) {
          const { name, input } = toolUse(step);
          const said = step.say ? [{ type: "text", text: step.say }] : [];
          yield { type: "assistant", session_id: SESSION, message: { content: [...said, { type: "tool_use", id: `toolu_${turns}`, name, input }] } } as unknown as SDKMessage;
          last = await execute(options, name, input, `toolu_${turns}`);
        } else if ("rateLimit" in step) {
          yield { type: "rate_limit_event", session_id: SESSION, rate_limit_info: { status: "rejected", resetsAt: step.rateLimit.resetsAt } } as unknown as SDKMessage;
          yield { type: "result", subtype: "error_during_execution", is_error: true, errors: ["Claude AI usage limit reached"], num_turns: turns, duration_ms: 1, total_cost_usd: 0, session_id: SESSION } as unknown as SDKMessage;
          return;
        } else if ("hang" in step) {
          // A model that never answers: the query ends only when the runtime aborts it, as the
          // SDK's does, by throwing.
          const signal = options.abortController?.signal;
          await new Promise<void>((resolve) => (signal?.aborted ? resolve() : signal?.addEventListener("abort", () => resolve(), { once: true })));
          throw new Error("Claude Code process aborted by user");
        } else if ("fail" in step) {
          yield { type: "result", subtype: "error_during_execution", is_error: true, errors: [step.fail], num_turns: turns, duration_ms: 1, total_cost_usd: 0, session_id: SESSION } as unknown as SDKMessage;
          return;
        } else {
          const answer = step.echo ? { ...step.answer, summary: last } : step.answer;
          const text = step.as === "text" ? JSON.stringify(answer) : "";
          yield { type: "result", subtype: "success", is_error: false, result: text, structured_output: step.as === "text" ? undefined : answer, num_turns: turns, duration_ms: 1, total_cost_usd: 0, session_id: SESSION } as unknown as SDKMessage;
          return;
        }
      }
    }
    return play() as Query;
  };
}
