// The machine's MCP client (RFC 0013), built once from the config: tokens in the state dir, the OAuth redirect at the board's address
// (`MACHINE_PUBLIC_URL`, else this machine's own port). Each stage gets its own client from `mcpFor`; the login API reads one for its status.
import { type Mcp, noTokenMcp } from "../application/mcp.ts";
import { createMcp } from "../adapters/mcp/client.ts";
import { recordingMcp, replayMcp } from "../adapters/mcp/replay.ts";
import { fileTokenStore, lunaOAuthProvider, tokenFor } from "../adapters/mcp/tokens.ts";
import type { Config } from "../config.ts";

export function mcpFactory(config: Pick<Config, "mcp" | "stateDir" | "publicUrl" | "port">, env: NodeJS.ProcessEnv = process.env) {
  const store = fileTokenStore(config.stateDir);
  const redirect = (server: string): string => `${config.publicUrl ?? `http://localhost:${config.port}`}/mcp/${server}/callback`;
  // `MCP_BRIDGE_MODE`: `live` (default), `record` (live, and write each list and call under MCP_FIXTURES) or `replay` (answer from those files, never connect).
  const mode = env.MCP_BRIDGE_MODE ?? "live";
  if (mode !== "live" && mode !== "record" && mode !== "replay") throw new Error(`MCP_BRIDGE_MODE must be live, record or replay, got "${mode}"`);
  const fixtures = env.MCP_FIXTURES;
  if (mode !== "live" && !fixtures) throw new Error(`MCP_BRIDGE_MODE=${mode} needs MCP_FIXTURES, the folder of the recorded answers`);
  const live = (): Mcp =>
    config.mcp.servers.length === 0
      ? noTokenMcp()
      : createMcp(config.mcp.servers, {
          token: tokenFor(store, env),
          authProvider: (server) => (server.credential.kind === "oauth" ? lunaOAuthProvider(store, server.name, redirect(server.name)) : undefined),
        });
  const mcpFor = (): Mcp => (mode === "replay" ? replayMcp(config.mcp.servers, fixtures!) : mode === "record" ? recordingMcp(live(), fixtures!) : live());
  return { store, redirect, mcpFor };
}
