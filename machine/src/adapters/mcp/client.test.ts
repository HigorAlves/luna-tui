import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, ErrorCode, McpError as RpcError } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createMcp, defaultTransport } from "./client.ts";

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

describe("createMcp after the connection dies", () => {
  it("connects again on the next call instead of keeping the dead client", async () => {
    const servers: McpServer[] = [];
    let connects = 0;
    const mcp = createMcp([declared], {
      token: async () => null,
      transportFor: () => {
        connects++;
        const [client, server] = InMemoryTransport.createLinkedPair();
        const s = fixtureServer();
        servers.push(s);
        void s.connect(server);
        return client;
      },
    });
    expect(await mcp.callTool("fixture", "echo", { word: "a" })).toMatchObject({ ok: true, text: "a" });
    await servers[0]!.close();
    await new Promise((r) => setTimeout(r, 20));
    expect(await mcp.callTool("fixture", "echo", { word: "b" })).toMatchObject({ ok: true, text: "b" });
    expect(connects).toBe(2);
  });
});

describe("createMcp evicts only for a transport failure", () => {
  /** A transport whose send fails once armed, with the pipe still open: a thrown transport error, not a close. */
  function flaky() {
    const connects: Array<{ failNext: () => void }> = [];
    const mcp = createMcp([declared], {
      token: async () => null,
      transportFor: () => {
        const [client, server] = InMemoryTransport.createLinkedPair();
        void fixtureServer().connect(server);
        let fail = false;
        const send = client.send.bind(client);
        client.send = async (message, options) => {
          if (fail) {
            fail = false;
            throw new Error("socket hang up");
          }
          return send(message, options);
        };
        connects.push({ failNext: () => (fail = true) });
        return client;
      },
    });
    return { mcp, connects };
  }
  it("callTool reconnects on the next call after a thrown transport error on an open transport", async () => {
    const { mcp, connects } = flaky();
    expect(await mcp.callTool("fixture", "echo", { word: "a" })).toMatchObject({ ok: true });
    connects[0]!.failNext();
    expect(await mcp.callTool("fixture", "echo", { word: "b" })).toMatchObject({ ok: false, error: expect.stringContaining("socket hang up") });
    expect(await mcp.callTool("fixture", "echo", { word: "c" })).toMatchObject({ ok: true, text: "c" });
    expect(connects).toHaveLength(2);
  });
  it("listTools reconnects on the next call after a thrown transport error on an open transport", async () => {
    const { mcp, connects } = flaky();
    expect(await mcp.listTools("fixture")).not.toEqual([]);
    connects[0]!.failNext();
    await expect(mcp.listTools("fixture")).rejects.toThrow("socket hang up");
    expect((await mcp.listTools("fixture")).map((t) => t.tool)).toContain("echo");
    expect(connects).toHaveLength(2);
  });
  it("a JSON-RPC error (InvalidParams) leaves the connection alone", async () => {
    let connects = 0;
    const mcp = createMcp([declared], {
      token: async () => null,
      transportFor: () => {
        connects++;
        const [client, server] = InMemoryTransport.createLinkedPair();
        const s = new Server({ name: "fixture", version: "1.0.0" }, { capabilities: { tools: {} } });
        s.setRequestHandler(CallToolRequestSchema, async (req) => {
          if (req.params.name === "boom") throw new RpcError(ErrorCode.InvalidParams, "bad arguments");
          return { content: [{ type: "text", text: "fine" }] };
        });
        void s.connect(server);
        return client;
      },
    });
    expect(await mcp.callTool("fixture", "echo", {})).toMatchObject({ ok: true, text: "fine" });
    expect(await mcp.callTool("fixture", "boom", {})).toMatchObject({ ok: false, error: expect.stringContaining("bad arguments") });
    expect(await mcp.callTool("fixture", "echo", {})).toMatchObject({ ok: true, text: "fine" });
    expect(connects).toBe(1);
  });
});

describe("defaultTransport", () => {
  const stdio = (credential: unknown) => ({ name: "s", transport: "stdio", command: ["node", "x.js"], credential, tools: [] }) as never;
  const envOf = (t: unknown) => (t as { _serverParams: { env: Record<string, string> } })._serverParams.env;
  it("hands a ref token only to that stdio child, as MCP_TOKEN", () => {
    expect(envOf(defaultTransport(stdio({ kind: "ref", ref: "env:X" }), "tok-1"))).toEqual({ MCP_TOKEN: "tok-1" });
    expect(envOf(defaultTransport(stdio({ kind: "none" }), null))).toEqual({});
    expect(envOf(defaultTransport(stdio({ kind: "oauth" }), "tok-1"))).toEqual({});
  });
});
