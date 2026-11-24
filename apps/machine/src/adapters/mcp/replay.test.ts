import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createMcp } from "./client.ts";
import { recordingMcp, replayMcp } from "./replay.ts";

const declared = { name: "fixture", transport: "http" as const, url: "https://fixture.invalid/mcp", credential: { kind: "none" as const }, tools: ["echo", "shot", "boom"] };

async function live() {
  const server = new McpServer({ name: "fixture", version: "1.0.0" });
  server.registerTool("echo", { description: "Echo", inputSchema: { word: z.string() } }, async ({ word }) => ({ content: [{ type: "text", text: word }] }));
  server.registerTool("shot", { description: "An image" }, async () => ({ content: [{ type: "image", data: Buffer.from("png").toString("base64"), mimeType: "image/png" }] }));
  server.registerTool("boom", { description: "Fails" }, async () => ({ isError: true, content: [{ type: "text", text: "nope" }] }));
  const [client, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  return createMcp([declared], { transportFor: () => client, token: async () => null });
}

describe("record and replay", () => {
  it("records each call and the tool list, then replays them without connecting", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-fixtures-"));
    const recorder = recordingMcp(await live(), dir);
    const tools = await recorder.listTools("fixture");
    const echoed = await recorder.callTool("fixture", "echo", { word: "hi" });
    const shot = await recorder.callTool("fixture", "shot", {});
    const boom = await recorder.callTool("fixture", "boom", {});
    expect(existsSync(join(dir, "fixture", "tools.json"))).toBe(true);
    expect(readdirSync(join(dir, "fixture", "echo"))).toHaveLength(1);
    expect(readdirSync(join(dir, "fixture", "echo"))[0]).toMatch(/^[0-9a-f]{64}\.json$/);
    expect(readFileSync(join(dir, "fixture", "shot", readdirSync(join(dir, "fixture", "shot"))[0]!), "utf8")).toContain(Buffer.from("png").toString("base64"));

    // A replay is given a client that throws if it is ever asked for a connection.
    const replay = replayMcp([declared], dir);
    expect(replay.servers()).toEqual([declared]);
    expect(await replay.listTools("fixture")).toEqual(tools);
    expect(await replay.callTool("fixture", "echo", { word: "hi" })).toEqual(echoed);
    expect(await replay.callTool("fixture", "shot", {})).toEqual(shot);
    expect(await replay.callTool("fixture", "boom", {})).toEqual(boom);
  });

  it("answers a call it never recorded with an error that names the tool, and a server it never listed with a rejection", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-fixtures-"));
    const replay = replayMcp([declared], dir);
    expect(await replay.callTool("fixture", "echo", { word: "other" })).toEqual({ ok: false, error: "no recorded answer for fixture.echo" });
    await expect(replay.listTools("fixture")).rejects.toThrow("no recorded tools for fixture");
  });

  it("keys a call by its arguments, whatever order their keys came in", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-fixtures-"));
    const recorder = recordingMcp(await live(), dir);
    await recorder.callTool("fixture", "echo", { word: "a", extra: 1 });
    expect((await replayMcp([declared], dir).callTool("fixture", "echo", { extra: 1, word: "a" })).ok).toBe(true);
  });
});
