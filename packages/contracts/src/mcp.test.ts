import { describe, expect, it } from "vitest";

import { McpServerConfig, bridgedName } from "./mcp.ts";

describe("McpServerConfig", () => {
  it("takes an http server with an oauth credential", () => {
    const s = McpServerConfig.parse({ name: "figma", transport: "http", url: "https://mcp.figma.com/mcp", credential: { kind: "oauth" }, tools: ["get_design_context"] });
    expect(s.tools).toEqual(["get_design_context"]);
  });
  it("refuses an http server without a url", () => {
    expect(McpServerConfig.safeParse({ name: "figma", transport: "http", credential: { kind: "none" }, tools: [] }).success).toBe(false);
  });
  it("refuses a stdio server without a command", () => {
    expect(McpServerConfig.safeParse({ name: "sb", transport: "stdio", credential: { kind: "none" }, tools: [] }).success).toBe(false);
  });
  it("refuses a name a tool name could not carry", () => {
    expect(McpServerConfig.safeParse({ name: "Figma_Remote", transport: "http", url: "https://x.dev/mcp", credential: { kind: "none" }, tools: [] }).success).toBe(false);
  });
  it("takes a credential reference", () => {
    const s = McpServerConfig.parse({ name: "zh", transport: "http", url: "https://x.dev/mcp", credential: { kind: "ref", ref: "op://vault/zh/token" }, tools: ["search"] });
    expect(s.credential).toEqual({ kind: "ref", ref: "op://vault/zh/token" });
  });
});

describe("bridgedName", () => {
  it("joins server and tool with an underscore, dashes to underscores", () => {
    expect(bridgedName("figma-desktop", "get_screenshot")).toBe("figma_desktop_get_screenshot");
  });
});
