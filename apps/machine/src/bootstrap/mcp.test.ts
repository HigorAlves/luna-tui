import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { mcpFactory } from "./mcp.ts";

const server = { name: "fixture", transport: "http" as const, url: "https://fixture.invalid/mcp", credential: { kind: "none" as const }, tools: ["echo"] };
const config = (servers = [server]) => ({ mcp: { servers, untrusted: "deny" as const }, stateDir: mkdtempSync(join(tmpdir(), "mcp-state-")), publicUrl: null, port: 8787 });

describe("mcpFactory", () => {
  it("builds the redirect from the board's address, else the machine's own port", () => {
    expect(mcpFactory(config(), {}).redirect("figma")).toBe("http://localhost:8787/mcp/figma/callback");
    expect(mcpFactory({ ...config(), publicUrl: "https://luna.example" }, {}).redirect("figma")).toBe("https://luna.example/mcp/figma/callback");
  });

  it("replays from MCP_FIXTURES without connecting, and says so when the folder is missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-fixtures-"));
    const mcp = mcpFactory(config(), { MCP_BRIDGE_MODE: "replay", MCP_FIXTURES: dir }).mcpFor();
    expect(await mcp.callTool("fixture", "echo", {})).toEqual({ ok: false, error: "no recorded answer for fixture.echo" });
    expect(() => mcpFactory(config(), { MCP_BRIDGE_MODE: "replay" })).toThrow("MCP_FIXTURES");
    expect(() => mcpFactory(config(), { MCP_BRIDGE_MODE: "record" })).toThrow("MCP_FIXTURES");
  });

  it("refuses a mode it does not know", () => {
    expect(() => mcpFactory(config(), { MCP_BRIDGE_MODE: "tape" })).toThrow("MCP_BRIDGE_MODE");
  });
});
