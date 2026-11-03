// The `luna` MCP server the stage agent talks to: the core luna tools (core/luna-tools.ts) served
// in-process by the runner, so the ledger is a file the runner owns (/out/ledger.json) and every
// call is also an event the machine ingests.
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { LunaTool } from "@hardness/contracts";

import { LUNA_TOOLS, type LunaToolsOptions, lunaHandlers } from "../../core/luna-tools.ts";

export type { LunaToolsOptions } from "../../core/luna-tools.ts";

const text = (value: unknown) => ({ content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value) }] });

/** The server config for `mcpServers.luna`, the state the runner reads at the end, and `call`
 *  for a runtime that serves the same handlers its own way. */
export function lunaTools(options: LunaToolsOptions) {
  const { state, call } = lunaHandlers(options);
  const server = createSdkMcpServer({
    name: "luna",
    version: "1.0.0",
    alwaysLoad: true,
    tools: (Object.keys(LUNA_TOOLS) as LunaTool[]).map((name) =>
      tool(name, LUNA_TOOLS[name].description, LUNA_TOOLS[name].input, async (args) => text(await call(name, args))),
    ),
  });
  return { server, state, call };
}
