// The core guards (core/guards.ts) as the Agent SDK's PreToolUse hooks: one matcher for Bash, one
// for the write tools, one for the read tools, one for WebFetch. A refused call gets the SDK's deny shape with the
// reason for the model.
import type { HookCallbackMatcher, HookInput, HookJSONOutput } from "@anthropic-ai/claude-agent-sdk";

import { type GuardContext, type GuardedCall, checkCall } from "../../core/guards.ts";

export { branchPrefixFor, guardBash, guardWrite, type GuardContext } from "../../core/guards.ts";

const WRITE_TOOLS = ["Write", "Edit", "MultiEdit", "NotebookEdit"];
const READ_TOOLS = ["Read", "Glob", "Grep"];

function deny(reason: string): HookJSONOutput {
  return {
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
  };
}

const toolInput = (input: HookInput): unknown => ("tool_input" in input ? input.tool_input : undefined);

/** Wraps a call as a hook callback. Fails closed: an exception while reading the input is a deny. */
function asHook(callOf: (input: HookInput) => GuardedCall, ctx: GuardContext): (input: HookInput) => Promise<HookJSONOutput> {
  return async (input) => {
    let call: GuardedCall;
    try {
      call = callOf(input);
    } catch (error) {
      return deny(`guard failed closed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const decision = checkCall(call, ctx);
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
export function preToolUseGuards(ctx: GuardContext): HookCallbackMatcher[] {
  return [
    { matcher: "^Bash$", hooks: [asHook((input) => ({ tool: "bash", input: toolInput(input) }), ctx)] },
    { matcher: `^(${WRITE_TOOLS.join("|")})$`, hooks: [asHook((input) => ({ tool: "write", input: writePath(input) }), ctx)] },
    { matcher: `^(${READ_TOOLS.join("|")})$`, hooks: [asHook((input) => ({ tool: "read", input: readPath(input) }), ctx)] },
    { matcher: "^WebFetch$", hooks: [asHook((input) => ({ tool: "fetch", input: toolInput(input) }), ctx)] },
  ];
}
