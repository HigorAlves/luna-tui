// The MCP adapter: one SDK client per declared server, connected on first use and kept until
// close(). Tokens come from `token(server)` (adapters/mcp/tokens.ts); a server error is a result.
import type { McpServerConfig } from "@hardness/contracts";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import { type ListedTool, type Mcp, McpError, type ShapedResult, shapeResult } from "../../application/mcp.ts";

export interface McpDeps {
  /** The bearer token for a server, or null for none (`credential.kind: none`). */
  token: (server: McpServerConfig) => Promise<string | null>;
  /** Tests pass an in-memory transport. */
  transportFor?: (server: McpServerConfig, token: string | null) => Transport;
  /** The OAuth provider for an `oauth` http server: the SDK then attaches and refreshes the token itself. */
  authProvider?: (server: McpServerConfig) => OAuthClientProvider | undefined;
}

/** The variable a stdio server's `ref` token reaches its child under. */
export const STDIO_TOKEN_ENV = "MCP_TOKEN";

/** A stdio server gets an empty environment on purpose: it must not inherit the machine's tokens. Only its own `ref` token goes in, as MCP_TOKEN. */
export function defaultTransport(server: McpServerConfig, token: string | null, authProvider?: OAuthClientProvider): Transport {
  if (server.transport === "stdio") {
    const env: Record<string, string> = server.credential.kind === "ref" && token ? { [STDIO_TOKEN_ENV]: token } : {};
    return new StdioClientTransport({ command: server.command![0]!, args: server.command!.slice(1), env });
  }
  if (authProvider) return new StreamableHTTPClientTransport(new URL(server.url!), { authProvider });
  return new StreamableHTTPClientTransport(new URL(server.url!), token ? { requestInit: { headers: { authorization: `Bearer ${token}` } } } : {});
}

export function createMcp(servers: readonly McpServerConfig[], deps: McpDeps): Mcp {
  const clients = new Map<string, Promise<Client>>();
  const declared = (name: string): McpServerConfig => {
    const s = servers.find((x) => x.name === name);
    if (!s) throw new McpError(`${name}: no such server on this machine`);
    return s;
  };
  const clientOf = (name: string): Promise<Client> => {
    let c = clients.get(name);
    if (!c) {
      const server = declared(name);
      c = (async () => {
        const client = new Client({ name: "luna-machine", version: "1.0.0" });
        await client.connect((deps.transportFor ?? ((sv, t) => defaultTransport(sv, t, deps.authProvider?.(sv))))(server, await deps.token(server)));
        return client;
      })();
      c.catch(() => clients.delete(name));
      clients.set(name, c);
    }
    return c;
  };
  return {
    servers: () => servers,
    async listTools(name): Promise<ListedTool[]> {
      const server = declared(name);
      const { tools } = await (await clientOf(name)).listTools();
      return tools
        .filter((t) => server.tools.includes(t.name))
        .map((t) => ({ server: name, tool: t.name, description: (t.description ?? "").slice(0, 2000), inputSchema: t.inputSchema as Record<string, unknown> }));
    },
    async callTool(name, tool, args): Promise<ShapedResult> {
      try {
        if (!declared(name).tools.includes(tool)) return { ok: false, error: `${name}: ${tool} is not bridged` };
        const r = await (await clientOf(name)).callTool({ name: tool, arguments: (args ?? {}) as Record<string, unknown> });
        return shapeResult((r.content ?? []) as never, r.isError === true);
      } catch (error) {
        return { ok: false, error: `${name}: ${(error as Error).message}`.slice(0, 2000) };
      }
    },
    async close() {
      await Promise.allSettled([...clients.values()].map(async (c) => (await c).close()));
      clients.clear();
    },
  };
}
