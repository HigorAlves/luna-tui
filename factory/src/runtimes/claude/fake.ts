// A scripted query() for the conformance table: it plays a script the way the Agent SDK would run
// it, through the options the runtime built. A tool call runs the runtime's PreToolUse hooks for
// that tool and, when they allow it, the luna server's handler; a denial's reason is what the
// model reads next, as the SDK reports it in the call's tool_result. A call that ran then goes
// through the PostToolUse hooks (PostToolUseFailure when it failed), and what they add as context
// is what the model reads with the result, and what `told` keeps for a check. The query ends as the
// SDK's does when the runtime aborts it. No model and no subprocess.
import type { HookCallbackMatcher, HookJSONOutput, Options, Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import type { ScriptStep } from "../conformance/table.ts";

type RegisteredTools = Record<string, { handler: (args: unknown, extra: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }> }>;

const SESSION = "fake-session";
/** What the SDK throws out of the stream when the run's abort controller fires. */
const ABORTED = "Claude Code process aborted by user";

/** The tool the SDK would name for a scripted call, and its input. */
function toolUse(step: Extract<ScriptStep, { call: string }>): { name: string; input: Record<string, unknown> } {
  if (step.call === "bash") return { name: "Bash", input: { command: step.command } };
  if (step.call === "delegate") return { name: "mcp__luna__delegate", input: { helper: step.helper, message: step.message } };
  return { name: `mcp__luna__${step.tool}`, input: step.args };
}

interface Executed {
  text: string;
  /** The result is an error. */
  denied: boolean;
  /** The call never ran: a PreToolUse hook refused it, or the tool is not there. */
  refused: boolean;
}

/** What the model reads back from one call: the hooks' denial, or what the tool returned (an error when it says so). */
async function execute(options: Options, name: string, input: Record<string, unknown>, id: string, fails?: string): Promise<Executed> {
  const matchers: HookCallbackMatcher[] = options.hooks?.PreToolUse ?? [];
  for (const matcher of matchers.filter((m) => new RegExp(m.matcher ?? ".*").test(name))) {
    for (const hook of matcher.hooks) {
      const decision = (await hook({ hook_event_name: "PreToolUse", tool_name: name, tool_input: input, tool_use_id: id, session_id: SESSION, transcript_path: "", cwd: options.cwd ?? "" } as never, id, { signal: new AbortController().signal })) as HookJSONOutput;
      const specific = "hookSpecificOutput" in decision ? (decision.hookSpecificOutput as { permissionDecision?: string; permissionDecisionReason?: string } | undefined) : undefined;
      if (specific?.permissionDecision === "deny") return { text: specific.permissionDecisionReason ?? "denied", denied: true, refused: true };
    }
  }
  if (name.startsWith("mcp__luna__")) {
    const server = options.mcpServers?.luna as { instance?: { _registeredTools?: RegisteredTools } } | undefined;
    const tool = server?.instance?._registeredTools?.[name.slice("mcp__luna__".length)];
    if (!tool) return { text: `no tool ${name}`, denied: true, refused: true };
    const result = await tool.handler(input, {});
    return { text: result.content[0]?.text ?? "", denied: result.isError === true, refused: false };
  }
  return fails === undefined ? { text: "(ran)", denied: false, refused: false } : { text: fails, denied: true, refused: false };
}

/** The PostToolUse hooks of a call that ran, or the PostToolUseFailure hooks of one that failed; the
 *  context they add, as the model is given it. */
async function after(options: Options, name: string, input: Record<string, unknown>, id: string, result: Executed): Promise<string[]> {
  const event = result.denied ? "PostToolUseFailure" : "PostToolUse";
  const matchers: HookCallbackMatcher[] = options.hooks?.[event] ?? [];
  const base = { hook_event_name: event, tool_name: name, tool_input: input, tool_use_id: id, session_id: SESSION, transcript_path: "", cwd: options.cwd ?? "" };
  const response = name === "Bash" ? { stdout: result.text, stderr: "", interrupted: false } : result.text;
  const told: string[] = [];
  for (const matcher of matchers.filter((m) => new RegExp(m.matcher ?? ".*").test(name))) {
    for (const hook of matcher.hooks) {
      const out = (await hook((result.denied ? { ...base, error: result.text } : { ...base, tool_response: response }) as never, id, { signal: new AbortController().signal })) as HookJSONOutput;
      const context = "hookSpecificOutput" in out ? (out.hookSpecificOutput as { additionalContext?: string } | undefined)?.additionalContext : undefined;
      if (context) told.push(context);
    }
  }
  return told;
}

/** The scripted `query()`, and `told`: every context a hook added, in order, as the model was given it. */
export function scriptedQuery(script: ScriptStep[]): ((params: { prompt: string; options?: Options }) => Query) & { told: string[] } {
  const told: string[] = [];
  const query = ({ options = {} }: { prompt: string; options?: Options }): Query => {
    async function* play(): AsyncGenerator<SDKMessage, void> {
      yield { type: "system", subtype: "init", session_id: SESSION, model: options.model ?? "", skills: [], plugins: [] } as unknown as SDKMessage;
      let last = "";
      let turns = 0;
      for (const step of script) {
        if (options.abortController?.signal.aborted) throw new Error(ABORTED);
        turns++;
        if ("call" in step) {
          const { name, input } = toolUse(step);
          const said = step.say ? [{ type: "text", text: step.say }] : [];
          yield { type: "assistant", session_id: SESSION, message: { content: [...said, { type: "tool_use", id: `toolu_${turns}`, name, input }] } } as unknown as SDKMessage;
          const id = `toolu_${turns}`;
          const result = await execute(options, name, input, id, step.call === "bash" ? step.fails : undefined);
          const context = result.refused ? [] : await after(options, name, input, id, result);
          told.push(...context);
          last = [result.text, ...context].join("\n");
          // The SDK takes real time between a hook and its next turn: what the runtime scheduled meanwhile (an abort) happens first.
          if (!result.refused) await new Promise((resolve) => setImmediate(resolve));
          yield { type: "user", session_id: SESSION, message: { role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_${turns}`, content: result.text, is_error: result.denied }] } } as unknown as SDKMessage;
        } else if ("rateLimit" in step) {
          yield { type: "rate_limit_event", session_id: SESSION, rate_limit_info: { status: "rejected", resetsAt: step.rateLimit.resetsAt } } as unknown as SDKMessage;
          yield { type: "result", subtype: "error_during_execution", is_error: true, errors: ["Claude AI usage limit reached"], num_turns: turns, duration_ms: 1, total_cost_usd: 0, session_id: SESSION } as unknown as SDKMessage;
          return;
        } else if ("hang" in step) {
          // A model that never answers: the query ends only when the runtime aborts it, as the
          // SDK's does, by throwing.
          const signal = options.abortController?.signal;
          await new Promise<void>((resolve) => (signal?.aborted ? resolve() : signal?.addEventListener("abort", () => resolve(), { once: true })));
          throw new Error(ABORTED);
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
  return Object.assign(query, { told });
}
