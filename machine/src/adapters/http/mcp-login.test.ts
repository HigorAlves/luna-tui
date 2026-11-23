import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { McpServerConfig } from "@hardness/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Mcp } from "../../application/mcp.ts";
import { fileTokenStore } from "../mcp/tokens.ts";
import { LOGIN_TTL_MS, createMcpApi } from "./mcp.ts";

const authMock = vi.hoisted(() => vi.fn());
vi.mock("@modelcontextprotocol/sdk/client/auth.js", () => ({ auth: authMock }));

const server: McpServerConfig = { name: "figma", transport: "http", url: "https://figma.invalid/mcp", credential: { kind: "oauth" }, tools: [] } as never;
const mcp = { servers: () => [server], listTools: async () => [], callTool: async () => ({ ok: false as const, error: "x" }), close: async () => {} } as Mcp;
const browser = async (provider: { saveClientInformation(i: unknown): Promise<void>; redirectToAuthorization(u: URL): void }) => {
  await provider.saveClientInformation({ client_id: "registered" });
  provider.redirectToAuthorization(new URL("https://auth.invalid/authorize"));
  return "REDIRECT";
};

describe("createMcpApi login (RFC 0013)", () => {
  beforeEach(() => authMock.mockReset());
  afterEach(() => vi.useRealTimers());

  it("keeps the stored tokens while the browser flow is open, so a login nobody finishes logs nothing out", async () => {
    const store = fileTokenStore(mkdtempSync(join(tmpdir(), "mcp-login-")));
    await store.save("figma", { access_token: "stale-value", token_type: "Bearer" });
    const api = createMcpApi({ mcp, store, redirectUrl: (s) => `http://localhost/mcp/${s}/callback` });
    authMock.mockImplementationOnce(browser);
    const { authorizeUrl, state } = await api.startLogin(server);
    expect(authorizeUrl).toBe("https://auth.invalid/authorize");
    expect(await api.loggedIn(server)).toBe(true);
    expect(await store.load("figma")).toMatchObject({ access_token: "stale-value" });
    expect(await store.loadClient("figma")).toMatchObject({ client_id: "registered" });

    authMock.mockImplementationOnce(async (provider) => {
      await provider.saveTokens({ access_token: "fresh-value", token_type: "Bearer" });
      return "AUTHORIZED";
    });
    await api.finishLogin(server, "code", state);
    expect(await store.load("figma")).toMatchObject({ access_token: "fresh-value" });
  });

  it("keeps the tokens when the SDK authorizes without the browser", async () => {
    const store = fileTokenStore(mkdtempSync(join(tmpdir(), "mcp-login-")));
    await store.save("figma", { access_token: "kept-value", token_type: "Bearer" });
    const api = createMcpApi({ mcp, store, redirectUrl: () => "http://localhost/cb" });
    authMock.mockResolvedValueOnce("AUTHORIZED");
    expect((await api.startLogin(server)).authorizeUrl).toBeNull();
    expect(await api.loggedIn(server)).toBe(true);
  });

  it("forgets an abandoned login after ten minutes: its state can no longer finish", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const store = fileTokenStore(mkdtempSync(join(tmpdir(), "mcp-login-")));
    const api = createMcpApi({ mcp, store, redirectUrl: () => "http://localhost/cb" });
    authMock.mockImplementationOnce(browser);
    const { state } = await api.startLogin(server);
    vi.advanceTimersByTime(LOGIN_TTL_MS + 1);
    await expect(api.finishLogin(server, "code", state)).rejects.toThrow("no login in progress");
  });
});
