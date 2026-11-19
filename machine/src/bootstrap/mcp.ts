// The machine's MCP client (RFC 0013), built once from the config: tokens in the state dir, the OAuth redirect at the board's address
// (`MACHINE_PUBLIC_URL`, else this machine's own port). Each stage gets its own client from `mcpFor`; the login API reads one for its status.
import { type Mcp, noTokenMcp } from "../application/mcp.ts";
import { createMcp } from "../adapters/mcp/client.ts";
import { fileTokenStore, lunaOAuthProvider, tokenFor } from "../adapters/mcp/tokens.ts";
import type { Config } from "../config.ts";

export function mcpFactory(config: Pick<Config, "mcp" | "stateDir" | "publicUrl" | "port">, env: NodeJS.ProcessEnv = process.env) {
  const store = fileTokenStore(config.stateDir);
  const redirect = (server: string): string => `${config.publicUrl ?? `http://localhost:${config.port}`}/mcp/${server}/callback`;
  const mcpFor = (): Mcp =>
    config.mcp.servers.length === 0
      ? noTokenMcp()
      : createMcp(config.mcp.servers, {
          token: tokenFor(store, env),
          authProvider: (server) => (server.credential.kind === "oauth" ? lunaOAuthProvider(store, server.name, redirect(server.name)) : undefined),
        });
  return { store, redirect, mcpFor };
}
