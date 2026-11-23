// The MCP routes (RFC 0013): status, login and the OAuth callback. No database: the app is built over stand-ins that these routes never touch.
import type { McpServerConfig } from "@hardness/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { type Mcp, NoMcpTokenError } from "../../application/mcp.ts";
import { type ApiAccess, createApp } from "./app.ts";
import { Bus } from "./bus.ts";
import { LOGIN_TTL_MS, type McpApi } from "./mcp.ts";

const TOKEN = "api-token-1234567890";
const access: ApiAccess = { host: "127.0.0.1", port: 4317, token: TOKEN };
const auth = { authorization: `Bearer ${TOKEN}` };

const figma = { name: "figma", transport: "http", url: "https://mcp.example/mcp", credential: { kind: "oauth" }, tools: ["get_screenshot"] } as McpServerConfig;
const local = { name: "local", transport: "http", url: "http://127.0.0.1:3845/mcp", credential: { kind: "none" }, tools: ["get_metadata"] } as McpServerConfig;

function fake() {
  const did: string[] = [];
  const mcp: Mcp = {
    servers: () => [figma, local],
    listTools: async (name) => {
      if (name === "figma") throw new NoMcpTokenError("figma");
      return [{ server: "local", tool: "get_metadata", description: "", inputSchema: {} }];
    },
    callTool: async () => ({ ok: false, error: "unused" }),
    close: async () => {},
  };
  const api: McpApi = {
    mcp,
    loggedIn: async (server) => server.credential.kind !== "oauth",
    startLogin: async (server) => (did.push(`start ${server.name}`), { authorizeUrl: "https://auth.example/authorize?state=s1", state: "s1" }),
    finishLogin: async (server, code, state) => void did.push(`finish ${server.name} ${code} ${state}`),
  };
  return { did, api };
}
const build = (api: McpApi) => createApp({ db: {} as never, pipeline: {} as never, bus: new Bus(), access, mcp: api });
const post = (path: string, headers: Record<string, string> = auth) => ({ path, init: { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: "{}" } });

describe("GET /mcp", () => {
  it("lists each server with its transport, login, pending login, tools and reachability, and no token", async () => {
    const res = await build(fake().api).request("http://127.0.0.1:4317/mcp", { headers: auth });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([
      { name: "figma", transport: "http", loggedIn: false, loginPending: false, tools: [], reachable: false },
      { name: "local", transport: "http", loggedIn: true, loginPending: false, tools: ["get_metadata"], reachable: true },
    ]);
  });
  it("needs the bearer token", async () => {
    expect((await build(fake().api).request("http://127.0.0.1:4317/mcp")).status).toBe(401);
  });
});

describe("login", () => {
  it("POST /mcp/figma/login returns the authorize URL the SDK flow built", async () => {
    const { api } = fake();
    const p = post("/mcp/figma/login");
    const res = await build(api).request(`http://127.0.0.1:4317${p.path}`, p.init);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ authorizeUrl: "https://auth.example/authorize?state=s1" });
  });
  it("needs the bearer token and a known server", async () => {
    const app = build(fake().api);
    const anon = post("/mcp/figma/login", {});
    expect((await app.request(`http://127.0.0.1:4317${anon.path}`, anon.init)).status).toBe(401);
    const unknown = post("/mcp/nope/login");
    expect((await app.request(`http://127.0.0.1:4317${unknown.path}`, unknown.init)).status).toBe(404);
  });
  it("GET /mcp/figma/callback finishes a login it started, without the token, and says so in HTML", async () => {
    const { api, did } = fake();
    const app = build(api);
    const p = post("/mcp/figma/login");
    await app.request(`http://127.0.0.1:4317${p.path}`, p.init);
    const res = await app.request("http://127.0.0.1:4317/mcp/figma/callback?code=abc&state=s1");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("Logged in to figma. You can close this tab.");
    expect(did).toEqual(["start figma", "finish figma abc s1"]);
  });
  it("refuses a state it did not issue, and one that was already used", async () => {
    const { api, did } = fake();
    const app = build(api);
    expect((await app.request("http://127.0.0.1:4317/mcp/figma/callback?code=abc&state=zz")).status).toBe(400);
    const p = post("/mcp/figma/login");
    await app.request(`http://127.0.0.1:4317${p.path}`, p.init);
    expect((await app.request("http://127.0.0.1:4317/mcp/figma/callback?code=abc&state=s1")).status).toBe(200);
    expect((await app.request("http://127.0.0.1:4317/mcp/figma/callback?code=abc&state=s1")).status).toBe(400);
    expect((await app.request("http://127.0.0.1:4317/mcp/figma/callback?code=abc")).status).toBe(400);
    expect(did.filter((d) => d.startsWith("finish"))).toHaveLength(1);
  });
  it("refuses a state issued for another server", async () => {
    const { api } = fake();
    const app = build(api);
    const p = post("/mcp/figma/login");
    await app.request(`http://127.0.0.1:4317${p.path}`, p.init);
    expect((await app.request("http://127.0.0.1:4317/mcp/local/callback?code=abc&state=s1")).status).toBe(400);
  });
});

describe("loginPending", () => {
  afterEach(() => vi.useRealTimers());
  const pending = async (app: ReturnType<typeof build>, name = "figma") => ((await (await app.request("http://127.0.0.1:4317/mcp", { headers: auth })).json()) as Array<{ name: string; loginPending: boolean }>).find((r) => r.name === name)!.loginPending;
  const start = async (app: ReturnType<typeof build>) => {
    const p = post("/mcp/figma/login");
    await app.request(`http://127.0.0.1:4317${p.path}`, p.init);
  };
  it("is true from the login that needs the browser until the callback finishes it", async () => {
    const app = build(fake().api);
    expect(await pending(app)).toBe(false);
    await start(app);
    expect(await pending(app)).toBe(true);
    expect(await pending(app, "local")).toBe(false);
    await app.request("http://127.0.0.1:4317/mcp/figma/callback?code=abc&state=s1");
    expect(await pending(app)).toBe(false);
  });
  it("stays true while the callback is still storing the tokens", async () => {
    const { api } = fake();
    let release!: () => void;
    api.finishLogin = () => new Promise<void>((resolve) => (release = resolve));
    const app = build(api);
    await start(app);
    const callback = app.request("http://127.0.0.1:4317/mcp/figma/callback?code=abc&state=s1");
    await new Promise((r) => setTimeout(r, 5));
    expect(await pending(app)).toBe(true);
    release();
    await callback;
    expect(await pending(app)).toBe(false);
  });
  it("is false again when the callback's login failed", async () => {
    const { api } = fake();
    api.finishLogin = async () => {
      throw new Error("denied");
    };
    const app = build(api);
    await start(app);
    expect((await app.request("http://127.0.0.1:4317/mcp/figma/callback?code=abc&state=s1")).status).toBe(502);
    expect(await pending(app)).toBe(false);
  });
  it("expires after ten minutes, and the state can no longer finish a login", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { api, did } = fake();
    const app = build(api);
    await start(app);
    vi.advanceTimersByTime(LOGIN_TTL_MS - 1000);
    expect(await pending(app)).toBe(true);
    vi.advanceTimersByTime(2000);
    expect(await pending(app)).toBe(false);
    expect((await app.request("http://127.0.0.1:4317/mcp/figma/callback?code=abc&state=s1")).status).toBe(400);
    expect(did.filter((d) => d.startsWith("finish"))).toEqual([]);
  });
  it("is false for a login that did not need the browser", async () => {
    const { api } = fake();
    api.startLogin = async () => ({ authorizeUrl: null, state: "s1" });
    const app = build(api);
    await start(app);
    expect(await pending(app)).toBe(false);
  });
});
