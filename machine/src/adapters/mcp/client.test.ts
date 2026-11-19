import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createMcp } from "./client.ts";

function fixtureServer() {
  const server = new McpServer({ name: "fixture", version: "1.0.0" });
  server.registerTool("echo", { description: "Echo a word", inputSchema: { word: z.string() } }, async ({ word }) => ({ content: [{ type: "text", text: word }] }));
  server.registerTool("big", { description: "A long text" }, async () => ({ content: [{ type: "text", text: "x".repeat(70_000) }] }));
  server.registerTool("shot", { description: "An image" }, async () => ({ content: [{ type: "image", data: Buffer.from("png").toString("base64"), mimeType: "image/png" }] }));
  server.registerTool("boom", { description: "Fails" }, async () => ({ isError: true, content: [{ type: "text", text: "nope" }] }));
  server.registerTool("hidden", { description: "Not declared" }, async () => ({ content: [] }));
  return server;
}

const declared = { name: "fixture", transport: "http" as const, url: "https://fixture.invalid/mcp", credential: { kind: "none" as const }, tools: ["echo", "big", "shot", "boom"] };

async function connected() {
  const [client, server] = InMemoryTransport.createLinkedPair();
  await fixtureServer().connect(server);
  return createMcp([declared], { transportFor: () => client, token: async () => null });
}

describe("createMcp", () => {
  it("lists only the declared tools", async () => {
    const mcp = await connected();
    expect((await mcp.listTools("fixture")).map((t) => t.tool).sort()).toEqual(["big", "boom", "echo", "shot"]);
  });
  it("calls a tool and returns its text", async () => {
    const mcp = await connected();
    expect(await mcp.callTool("fixture", "echo", { word: "hi" })).toEqual({ ok: true, text: "hi", images: [], truncated: false });
  });
  it("caps text at 64 KB", async () => {
    const r = await (await connected()).callTool("fixture", "big", {});
    expect(r.ok && r.text.length).toBe(64_000);
    expect(r.ok && r.truncated).toBe(true);
  });
  it("returns images apart from the text", async () => {
    const r = await (await connected()).callTool("fixture", "shot", {});
    expect(r.ok && r.images).toEqual([{ mime: "image/png", bytes: Buffer.from("png") }]);
    expect(r.ok && r.text).toBe("");
  });
  it("turns a tool error into a result", async () => {
    expect(await (await connected()).callTool("fixture", "boom", {})).toEqual({ ok: false, error: "nope" });
  });
  it("refuses a tool the machine does not declare", async () => {
    expect(await (await connected()).callTool("fixture", "hidden", {})).toEqual({ ok: false, error: "fixture: hidden is not bridged" });
  });
});
