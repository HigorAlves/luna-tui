// Record and replay of the MCP bridge (RFC 0013): `MCP_BRIDGE_MODE=record` writes each tool list and each call under
// `MCP_FIXTURES/<server>/`, `replay` answers from those files and never connects, so a design stage can be rerun offline.
// A fixture holds what the server returned: results with image bytes in base64. Tokens never reach a file; they are not in a result.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { McpServerConfig } from "@hardness/contracts";

import { type ListedTool, type Mcp, McpError, type ShapedResult } from "../../application/mcp.ts";

/** JSON with the keys of every object in order, so the same arguments in another key order are the same call. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

const callFile = (dir: string, server: string, tool: string, args: unknown): string => join(dir, server, tool, `${createHash("sha256").update(canonical(args ?? {})).digest("hex")}.json`);
const toolsFile = (dir: string, server: string): string => join(dir, server, "tools.json");

type Stored = { ok: true; text: string; images: { mime: string; base64: string }[]; truncated: boolean } | { ok: false; error: string };

const store = (result: ShapedResult): Stored => (result.ok ? { ok: true, text: result.text, images: result.images.map((i) => ({ mime: i.mime, base64: i.bytes.toString("base64") })), truncated: result.truncated } : result);
const load = (stored: Stored): ShapedResult => (stored.ok ? { ok: true, text: stored.text, images: stored.images.map((i) => ({ mime: i.mime, bytes: Buffer.from(i.base64, "base64") })), truncated: stored.truncated } : stored);

const write = (file: string, value: unknown): void => {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2));
};

/** The real client, with every list and call written under `dir`. */
export function recordingMcp(inner: Mcp, dir: string): Mcp {
  return {
    servers: () => inner.servers(),
    async listTools(server) {
      const tools = await inner.listTools(server);
      write(toolsFile(dir, server), tools);
      return tools;
    },
    async callTool(server, tool, args) {
      const result = await inner.callTool(server, tool, args);
      write(callFile(dir, server, tool, args), store(result));
      return result;
    },
    close: () => inner.close(),
  };
}

/** Answers from what `recordingMcp` wrote; a call or list with no file is a miss, and nothing is ever connected. */
export function replayMcp(servers: readonly McpServerConfig[], dir: string): Mcp {
  const read = (file: string): unknown => {
    try {
      return JSON.parse(readFileSync(file, "utf8"));
    } catch {
      return undefined;
    }
  };
  return {
    servers: () => servers,
    async listTools(server) {
      const tools = read(toolsFile(dir, server));
      if (!Array.isArray(tools)) throw new McpError(`no recorded tools for ${server}`);
      return tools as ListedTool[];
    },
    async callTool(server, tool, args) {
      const stored = read(callFile(dir, server, tool, args));
      return stored ? load(stored as Stored) : { ok: false, error: `no recorded answer for ${server}.${tool}` };
    },
    close: async () => {},
  };
}
