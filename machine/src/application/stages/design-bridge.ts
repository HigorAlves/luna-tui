// The machine's side of a stage's bridged design tools (RFC 0013): which tools this run is given, and the answer to each call
// the stage makes through the checks mailbox. The run's own grants decide; a request is only a name.
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { type BridgeGrant, type BridgedTool, bridgedName } from "@hardness/contracts";

import { grantedTools, type RepoNarrowing } from "../../domain/bridge.ts";
import type { Mcp } from "../mcp.ts";
import type { McpAnswer, McpRequest } from "./build-watch.ts";

/** The folder of the run where bridged images are written, mounted read-only at `/design`. */
export const DESIGN_MOUNT = "/design";

/** The tools this run may call: the pack's grants, the machine's servers and the repo's narrowing, kept to what each server lists now. A server that cannot list is a note and is skipped. */
export async function bridgeFor(opts: {
  mcp: Mcp;
  pack: readonly BridgeGrant[];
  repo: RepoNarrowing;
  trust: "trusted" | "untrusted";
  untrusted: "allow" | "deny";
}): Promise<{ tools: BridgedTool[]; notes: string[] }> {
  const { grants, notes } = grantedTools(opts.pack, opts.mcp.servers(), opts.repo, opts.trust, { untrusted: opts.untrusted });
  const tools: BridgedTool[] = [];
  for (const grant of grants) {
    try {
      for (const listed of await opts.mcp.listTools(grant.server)) {
        if (!grant.tools.includes(listed.tool)) continue;
        tools.push({ server: listed.server, tool: listed.tool, name: bridgedName(listed.server, listed.tool), description: listed.description.slice(0, 2000), inputSchema: listed.inputSchema });
      }
    } catch (error) {
      // An McpError already names its server; any other failure gets the name here.
      const message = error instanceof Error ? error.message : String(error);
      notes.push(message.startsWith(`${grant.server}:`) ? message : `${grant.server}: ${message}`);
    }
  }
  return { tools, notes };
}

export interface McpCallRow {
  server: string;
  tool: string;
  n: number;
  argsSha256: string;
  bytes: number;
  outcome: "ok" | "error" | "refused" | "capped";
}

const sha = (value: unknown): string => createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex");
const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "image/svg+xml": "svg" };

/** The row of a call the watch refused for the run's cap. Carries no result, so no byte count. */
export const cappedRow = (request: McpRequest): McpCallRow => ({ server: request.server, tool: request.tool, n: request.n, argsSha256: sha(request.args), bytes: 0, outcome: "capped" });

/** Answers a stage's call: only a tool in `bridge`, through `mcp`; the text is wrapped as data, images are files under `designDir`. Logs one row per call. Never throws. */
export function mcpAnswers(opts: { mcp: Mcp; bridge: readonly BridgedTool[]; designDir: string; log: (row: McpCallRow) => void | Promise<void> }) {
  return async (request: McpRequest): Promise<McpAnswer> => {
    const row = { server: request.server, tool: request.tool, n: request.n, argsSha256: sha(request.args) };
    const done = async (answer: McpAnswer, bytes: number, outcome: McpCallRow["outcome"]): Promise<McpAnswer> => {
      await Promise.resolve(opts.log({ ...row, bytes, outcome })).catch(() => {});
      return answer;
    };
    if (!opts.bridge.some((b) => b.server === request.server && b.tool === request.tool)) {
      return done({ ok: false, error: `${request.server}.${request.tool} is not available in this run` }, 0, "refused");
    }
    try {
      const result = await opts.mcp.callTool(request.server, request.tool, request.args ?? {});
      if (!result.ok) return await done({ ok: false, error: result.error }, Buffer.byteLength(result.error), "error");
      await mkdir(opts.designDir, { recursive: true });
      const images: string[] = [];
      let bytes = Buffer.byteLength(result.text);
      for (const [i, image] of result.images.entries()) {
        const name = `${request.n}-${i}.${EXT[image.mime] ?? "bin"}`;
        await writeFile(join(opts.designDir, name), image.bytes);
        images.push(`${DESIGN_MOUNT}/${name}`);
        bytes += image.bytes.length;
      }
      // The result is the server's text: it cannot close the data tag it is wrapped in.
      const text = `<data source="${request.server}.${request.tool}">${result.text.replaceAll("</data", "<\\/data")}</data>`;
      return await done({ ok: true, text, images, truncated: result.truncated }, bytes, "ok");
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 500) : "the call failed";
      return done({ ok: false, error: message }, 0, "error");
    }
  };
}
