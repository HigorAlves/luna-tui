// The `luna` MCP server the stage agent talks to: the core luna tools (core/luna-tools.ts) served
// in-process by the runner, so the ledger is a file the runner owns (/out/ledger.json) and every
// call is also an event the machine ingests.
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { LunaTool } from "@hardness/contracts";

import { DELEGATE, type DelegateTool } from "../../core/delegate.ts";
import { LUNA_TOOLS } from "../../core/luna-tools.ts";
import type { RunContext } from "../../core/runtime.ts";

const text = (value: unknown) => ({ content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value) }] });

/** A result that says it failed: `{ error }`. */
const failed = (value: unknown): boolean => typeof value === "object" && value !== null && "error" in value;

/** The server config for `mcpServers.luna`, over the handlers' `call` (core/luna-tools.ts keeps
 *  the state), with `delegate` beside them when the run delegates: a helper that gave no answer
 *  is the call's error. Built by the Claude runtime only, so no other runtime loads the SDK for it. */
export function lunaServer(call: RunContext["luna"]["call"], delegate: DelegateTool | null = null) {
  return createSdkMcpServer({
    name: "luna",
    version: "1.0.0",
    alwaysLoad: true,
    tools: [
      ...(Object.keys(LUNA_TOOLS) as LunaTool[]).map((name) =>
        tool(name, LUNA_TOOLS[name].description, LUNA_TOOLS[name].input, async (args) => text(await call(name, args))),
      ),
      ...(delegate
        ? [
            tool(DELEGATE, delegate.description, delegate.input, async (args) => {
              const value = await call(DELEGATE, args);
              return { ...text(value), ...(failed(value) && { isError: true }) };
            }),
          ]
        : []),
    ],
  });
}
