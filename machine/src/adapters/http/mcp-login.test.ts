import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { McpServerConfig } from "@hardness/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Mcp } from "../../application/mcp.ts";
import { fileTokenStore } from "../mcp/tokens.ts";
import { createMcpApi } from "./mcp.ts";

const authMock = vi.hoisted(() => vi.fn());
vi.mock("@modelcontextprotocol/sdk/client/auth.js", () => ({ auth: authMock }));

const server: McpServerConfig = { name: "figma", transport: "http", url: "https://figma.invalid/mcp", credential: { kind: "oauth" }, tools: [] } as never;
const mcp = { servers: () => [server], listTools: async () => [], callTool: async () => ({ ok: false as const, error: "x" }), close: async () => {} } as Mcp;

describe("createMcpApi login (RFC 0013)", () => {
  beforeEach(() => authMock.mockReset());

  it("is not logged in while the browser flow is open, even with an old token on disk, and is once the callback stores fresh ones", async () => {
    const store = fileTokenStore(mkdtempSync(join(tmpdir(), "mcp-login-")));
    await store.save("figma", { access_token: "stale-value", token_type: "Bearer" });
    const api = createMcpApi({ mcp, store, redirectUrl: (s) => `http://localhost/mcp/${s}/callback` });
    expect(await api.loggedIn(server)).toBe(true);

    // The SDK registers a client and asks for the browser: the stale token did not work.
    authMock.mockImplementationOnce(async (provider) => {
      await provider.saveClientInformation({ client_id: "registered" });
      provider.redirectToAuthorization(new URL("https://auth.invalid/authorize"));
      return "REDIRECT";
    });
    const { authorizeUrl, state } = await api.startLogin(server);
    expect(authorizeUrl).toBe("https://auth.invalid/authorize");
    expect(await api.loggedIn(server)).toBe(false);
    expect(await store.loadClient("figma")).toMatchObject({ client_id: "registered" });

    authMock.mockImplementationOnce(async (provider) => {
      await provider.saveTokens({ access_token: "fresh-value", token_type: "Bearer" });
      return "AUTHORIZED";
    });
    await api.finishLogin(server, "code", state);
    expect(await api.loggedIn(server)).toBe(true);
  });

  it("keeps the tokens when the SDK authorizes without the browser", async () => {
    const store = fileTokenStore(mkdtempSync(join(tmpdir(), "mcp-login-")));
    await store.save("figma", { access_token: "kept-value", token_type: "Bearer" });
    const api = createMcpApi({ mcp, store, redirectUrl: () => "http://localhost/cb" });
    authMock.mockResolvedValueOnce("AUTHORIZED");
    expect((await api.startLogin(server)).authorizeUrl).toBeNull();
    expect(await api.loggedIn(server)).toBe(true);
  });
});
