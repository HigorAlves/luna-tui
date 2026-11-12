// The core guards (core/guards.ts) as the Agent SDK's PreToolUse hooks: one matcher for Bash, one
// for the write tools, one for the read tools, one for WebFetch. A refused call gets the SDK's deny shape with the
// reason for the model. Every decision, allowed or refused, is also handed to `onDecision`, which
// the runtime turns into the call's event.
import type { HookCallbackMatcher, HookInput, HookJSONOutput } from "@anthropic-ai/claude-agent-sdk";
import type { Observation } from "@hardness/contracts";

import type { GuardStep } from "../../core/economy/guard.ts";
import type { EconomySession } from "../../core/economy/session.ts";
import { type GuardContext, type GuardDecision, type GuardedCall, checkCall } from "../../core/guards.ts";

export { branchPrefixFor, guardBash, guardWrite, type GuardContext } from "../../core/guards.ts";

const WRITE_TOOLS = ["Write", "Edit", "MultiEdit", "NotebookEdit"];
const READ_TOOLS = ["Read", "Glob", "Grep"];
const GUARDED = new Set(["Bash", ...WRITE_TOOLS, ...READ_TOOLS, "WebFetch"]);

/** Whether a tool's calls pass a guard here. */
export const isGuarded = (tool: string): boolean => GUARDED.has(tool);

/** Hears every guard decision: the SDK's call id, the tool, its input and what the guard said. */
export type OnDecision = (id: string, tool: string, input: unknown, decision: GuardDecision) => void;

function deny(reason: string): HookJSONOutput {
  return {
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
  };
}

const toolInput = (input: HookInput): unknown => ("tool_input" in input ? input.tool_input : undefined);

/** Wraps a call as a hook callback. Fails closed: an exception while reading the input is a deny. */
function asHook(callOf: (input: HookInput) => GuardedCall, ctx: GuardContext, onDecision?: OnDecision): (input: HookInput, id: string | undefined) => Promise<HookJSONOutput> {
  return async (input, id) => {
    let decision: GuardDecision;
    try {
      decision = checkCall(callOf(input), ctx);
    } catch (error) {
      decision = { allow: false, reason: `guard failed closed: ${error instanceof Error ? error.message : String(error)}` };
    }
    // Hearing the decision never changes it.
    try {
      onDecision?.(id ?? "", "tool_name" in input ? input.tool_name : "tool", toolInput(input), decision);
    } catch {}
    return decision.allow ? {} : deny(decision.reason);
  };
}

/** The write tools name their target `file_path`, a notebook edit `notebook_path`. */
function writePath(input: HookInput): { path: unknown } {
  const target = toolInput(input);
  if (typeof target !== "object" || target === null) return { path: undefined };
  const fields = target as Record<string, unknown>;
  return { path: typeof fields.file_path === "string" ? fields.file_path : fields.notebook_path };
}

/** Read names its target `file_path`; Glob and Grep a folder `path` (the worktree when absent)
 *  and a `pattern`, which for Glob may name a folder of its own. */
function readPath(input: HookInput): { path: unknown; pattern?: unknown } {
  const target = toolInput(input);
  if (typeof target !== "object" || target === null) return { path: undefined };
  const fields = target as Record<string, unknown>;
  if ("tool_name" in input && input.tool_name === "Read") return { path: fields.file_path };
  return { path: fields.path ?? ".", pattern: "tool_name" in input && input.tool_name === "Glob" ? fields.pattern : undefined };
}

/** The SDK hook matchers for PreToolUse: one for Bash, one for the write tools, one for the read
 *  tools, one for WebFetch. Fails closed: any exception inside a guard denies. */
export function preToolUseGuards(ctx: GuardContext, onDecision?: OnDecision): HookCallbackMatcher[] {
  return [
    { matcher: "^Bash$", hooks: [asHook((input) => ({ tool: "bash", input: toolInput(input) }), ctx, onDecision)] },
    { matcher: `^(${WRITE_TOOLS.join("|")})$`, hooks: [asHook((input) => ({ tool: "write", input: writePath(input) }), ctx, onDecision)] },
    { matcher: `^(${READ_TOOLS.join("|")})$`, hooks: [asHook((input) => ({ tool: "read", input: readPath(input) }), ctx, onDecision)] },
    { matcher: "^WebFetch$", hooks: [asHook((input) => ({ tool: "fetch", input: toolInput(input) }), ctx, onDecision)] },
  ];
}

/** Hears what the economy session made of a finished call: the SDK's call id, its observation, the step. */
export type OnSettled = (id: string, observation: Observation | undefined, step: GuardStep) => void;

const RESULT_CAP = 20000;
/** The keys of a response object that hold its text, in the order upstream reads them. */
const TEXT_KEYS = ["stdout", "stderr", "output", "aggregated_output", "formatted_output", "content", "result", "error", "message", "text_result_for_llm"];

/** A tool's response as text for the observer, as upstream's host reads it: a string as is; a list by its items' `text`; an Edit or
 *  Write response (a `structuredPatch`, or the file tools' `create`/`update` shape) as nothing, since its fields echo what was written;
 *  any other object by its string values under the text keys. The text is read and dropped, never emitted. */
function outputText(response: unknown): string {
  return responseText(response).slice(0, RESULT_CAP);
}

function responseText(response: unknown): string {
  if (typeof response === "string") return response;
  if (Array.isArray(response)) return response.flatMap((item) => (typeof item === "object" && item !== null && typeof (item as { text?: unknown }).text === "string" ? [(item as { text: string }).text] : [])).join("\n");
  if (typeof response !== "object" || response === null) return "";
  const fields = response as Record<string, unknown>;
  if ("structuredPatch" in fields) return "";
  if ((fields.type === "create" || fields.type === "update") && (typeof fields.filePath === "string" || typeof fields.file_path === "string")) return "";
  return TEXT_KEYS.flatMap((key) => (typeof fields[key] === "string" ? [fields[key] as string] : [])).join("\n");
}

/** The PostToolUse and PostToolUseFailure matchers of the token economy, for every tool: each
 *  finished call goes to the session, and a redirect goes back to the model as the hook's additional
 *  context. Fails open, unlike the guards: a fault here costs the economy, never the run. */
export function postToolUseEconomy(session: EconomySession, onSettled: OnSettled): { PostToolUse: HookCallbackMatcher[]; PostToolUseFailure: HookCallbackMatcher[] } {
  const hook = (event: "PostToolUse" | "PostToolUseFailure") => async (input: HookInput, id: string | undefined): Promise<HookJSONOutput> => {
    try {
      if (!("tool_name" in input) || input.hook_event_name !== event) return {};
      const failed = input.hook_event_name === "PostToolUseFailure";
      const output = failed ? String(input.error ?? "") : outputText(input.tool_response);
      const callId = id ?? input.tool_use_id;
      // A subagent's call is observed for its event; the guard counts the main thread's calls only, and a redirect would land in the wrong context.
      const subagent = typeof input.agent_id === "string" && input.agent_id !== "";
      const { observation, step } = session.settled({ id: callId, tool: input.tool_name, input: input.tool_input, output, ok: !failed, subagent });
      onSettled(callId, observation, step);
      return !subagent && step.kind === "redirect" ? { hookSpecificOutput: { hookEventName: event, additionalContext: step.text } } : {};
    } catch {
      return {};
    }
  };
  return { PostToolUse: [{ hooks: [hook("PostToolUse")] }], PostToolUseFailure: [{ hooks: [hook("PostToolUseFailure")] }] };
}
