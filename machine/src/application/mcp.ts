// The MCP port: the machine lists and calls the tools of the servers it declares (RFC 0013).
// Only the machine connects; a stage reaches a tool through the checks mailbox.
import type { McpServerConfig } from "@hardness/contracts";

export class McpError extends Error {}
export class NoMcpTokenError extends McpError {
  constructor(server: string) {
    super(`${server}: not logged in (pnpm mcp login ${server})`);
  }
}

/** The cap on a result's text, in characters. */
export const MAX_RESULT_TEXT = 64_000;

export interface ListedTool {
  server: string;
  tool: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export type ShapedResult = { ok: true; text: string; images: { mime: string; bytes: Buffer }[]; truncated: boolean } | { ok: false; error: string };

export interface Mcp {
  servers(): readonly McpServerConfig[];
  listTools(server: string): Promise<ListedTool[]>;
  callTool(server: string, tool: string, args: unknown): Promise<ShapedResult>;
  close(): Promise<void>;
}

/** No server is usable: every list rejects, so no stage is offered a bridged tool. */
export function noTokenMcp(servers: readonly McpServerConfig[] = []): Mcp {
  return {
    servers: () => servers,
    listTools: (server) => Promise.reject(new NoMcpTokenError(server)),
    callTool: async (server) => ({ ok: false, error: new NoMcpTokenError(server).message }),
    close: async () => {},
  };
}

type Part = { type: string; text?: string; data?: string; mimeType?: string; resource?: { text?: string } };

/** A tool result as the stage may read it: text joined and capped, images apart. */
export function shapeResult(content: readonly Part[], isError: boolean): ShapedResult {
  const texts: string[] = [];
  const images: { mime: string; bytes: Buffer }[] = [];
  for (const p of content) {
    if (p.type === "text" && p.text) texts.push(p.text);
    else if (p.type === "resource" && p.resource?.text) texts.push(p.resource.text);
    else if (p.type === "image" && p.data && p.mimeType) images.push({ mime: p.mimeType, bytes: Buffer.from(p.data, "base64") });
  }
  const text = texts.join("\n");
  if (isError) return { ok: false, error: text.slice(0, 2000) || "the tool failed" };
  return { ok: true, text: text.slice(0, MAX_RESULT_TEXT), images, truncated: text.length > MAX_RESULT_TEXT };
}
