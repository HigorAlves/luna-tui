// The MCP servers the machine declares and the tools it bridges into a stage (RFC 0013). Only
// the machine declares a server; a repo narrows; a pack names the tools it may call.
import { z } from "zod";

const NAME = /^[a-z][a-z0-9-]{0,30}$/;

export const McpCredential = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({ kind: z.literal("oauth"), scopes: z.array(z.string()).optional() }),
  /** `env:NAME`, `literal:<v>` or `op://…`, resolved by the machine (RFC 0013). */
  z.object({ kind: z.literal("ref"), ref: z.string().min(1) }),
]);
export type McpCredential = z.infer<typeof McpCredential>;

export const McpServerConfig = z
  .object({
    name: z.string().regex(NAME),
    transport: z.enum(["http", "stdio"]),
    url: z.string().url().optional(),
    command: z.array(z.string()).min(1).optional(),
    credential: McpCredential,
    /** The tools the machine bridges at most; a pack and a repo can only narrow. */
    tools: z.array(z.string().min(1)),
  })
  .refine((s) => (s.transport === "http" ? !!s.url : !!s.command), { message: "an http server needs url, a stdio server needs command" });
export type McpServerConfig = z.infer<typeof McpServerConfig>;

/** What a pack's access names: a server and the tools of it the pack may call. */
export interface BridgeGrant {
  server: string;
  tools: string[];
}

/** One bridged tool as the stage gets it: the machine listed it from the server. */
export const BridgedTool = z.object({
  server: z.string(),
  tool: z.string(),
  /** The luna tool name, `bridgedName(server, tool)`. */
  name: z.string(),
  description: z.string().max(2000),
  /** The server's JSON Schema for the input, as listed. */
  inputSchema: z.record(z.string(), z.unknown()),
});
export type BridgedTool = z.infer<typeof BridgedTool>;

export const bridgedName = (server: string, tool: string): string => `${server.replaceAll("-", "_")}_${tool}`;
