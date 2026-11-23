// The MCP routes (RFC 0013): which servers the machine bridges and whether each is logged in, a login that
// hands back the authorize URL, and the OAuth callback the browser lands on. The callback is the one route
// with no bearer token (a redirect cannot carry one); it finishes only a login this machine started, by the
// `state` it issued, once, within ten minutes. `GET /mcp` says a login is pending while such a state is outstanding. No token value ever reaches a response.
import { randomBytes } from "node:crypto";
import type { McpServerConfig } from "@hardness/contracts";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import type { Hono } from "hono";

import type { Mcp } from "../../application/mcp.ts";
import { type OAuthProvider, type TokenStore, lunaOAuthProvider } from "../mcp/tokens.ts";

export interface McpApi {
  /** The machine's clients, for the tools each server lists. */
  mcp: Mcp;
  loggedIn(server: McpServerConfig): Promise<boolean>;
  /** Starts an OAuth login: the URL to open, and the `state` the callback must carry back. */
  startLogin(server: McpServerConfig): Promise<{ authorizeUrl: string | null; state: string }>;
  finishLogin(server: McpServerConfig, code: string, state: string): Promise<void>;
}

const REACH_MS = 5_000;
/** How long a login state stays good: past it the browser flow is abandoned, and its entry is dropped. */
export const LOGIN_TTL_MS = 10 * 60_000;
const within = <T>(promise: Promise<T>, ms: number): Promise<T> => {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error("timed out")), ms)));
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};

const page = (message: string): string => `<!doctype html><meta charset="utf-8"><title>Luna</title><body style="font-family:system-ui;margin:3rem"><p>${message}</p></body>`;
const escape = (s: string): string => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

/** A state this process issued: the server it is for, whether a callback already took it (it is kept until that callback settles, so the login still reads as pending), and the timer that drops it. */
interface Issued {
  server: string;
  used: boolean;
  timer: NodeJS.Timeout;
}

/** The states this process issued: a callback finishes only one of them, once. */
const issued = new WeakMap<McpApi, Map<string, Issued>>();

/** Before the API guard: the callback, the only unauthenticated MCP route. */
export function mountMcpCallback(app: Hono, api: McpApi): void {
  const states = new Map<string, Issued>();
  issued.set(api, states);
  app.get("/mcp/:server/callback", async (c) => {
    const name = c.req.param("server");
    const state = c.req.query("state") ?? "";
    const code = c.req.query("code") ?? "";
    const server = api.mcp.servers().find((s) => s.name === name);
    const entry = states.get(state);
    if (!server || !code || !state || !entry || entry.server !== name || entry.used) return c.html(page("This login was not started by this machine."), 400);
    entry.used = true;
    try {
      await api.finishLogin(server, code, state);
    } catch {
      return c.html(page(`Login to ${escape(name)} failed. Run pnpm mcp login ${escape(name)} again.`), 502);
    } finally {
      clearTimeout(entry.timer);
      states.delete(state);
    }
    return c.html(page(`Logged in to ${escape(name)}. You can close this tab.`));
  });
}

/** After the API guard: status and login. */
export function mountMcpRoutes(app: Hono, api: McpApi): void {
  const states = issued.get(api) ?? new Map<string, Issued>();
  app.get("/mcp", async (c) =>
    c.json(
      await Promise.all(
        api.mcp.servers().map(async (server) => {
          const loggedIn = await api.loggedIn(server).catch(() => false);
          const tools = loggedIn ? await within(api.mcp.listTools(server.name), REACH_MS).then((list) => list.map((t) => t.tool), () => null) : null;
          const loginPending = [...states.values()].some((entry) => entry.server === server.name);
          return { name: server.name, transport: server.transport, loggedIn, loginPending, tools: tools ?? [], reachable: tools !== null };
        }),
      ),
    ),
  );
  app.post("/mcp/:server/login", async (c) => {
    const server = api.mcp.servers().find((s) => s.name === c.req.param("server"));
    if (!server) return c.json({ error: "no_server", message: `no MCP server ${c.req.param("server")} on this machine` }, 404);
    if (server.credential.kind !== "oauth") return c.json({ error: "not_oauth", message: `${server.name} does not log in through OAuth` }, 409);
    const { authorizeUrl, state } = await api.startLogin(server);
    if (authorizeUrl !== null) {
      const timer = setTimeout(() => states.delete(state), LOGIN_TTL_MS);
      timer.unref();
      states.set(state, { server: server.name, used: false, timer });
    }
    return c.json({ authorizeUrl });
  });
}

/** The real thing: the SDK's `auth()` over the token store. A login keeps its provider (and PKCE verifier) from start to finish. */
export function createMcpApi({ mcp, store, redirectUrl }: { mcp: Mcp; store: TokenStore; redirectUrl: (server: string) => string }): McpApi {
  const logins = new Map<string, { server: string; provider: OAuthProvider & { state(): string } }>();
  const providerFor = (server: McpServerConfig, state: string) => {
    const scope = server.credential.kind === "oauth" ? server.credential.scopes?.join(" ") : undefined;
    const base = lunaOAuthProvider(store, server.name, redirectUrl(server.name), scope ? { scope } : {});
    // The SDK reads `state` when it builds the authorize URL; the object keeps the provider's own methods.
    return Object.assign(Object.create(base) as OAuthProvider, { state: () => state }) as OAuthProvider & { state(): string };
  };
  return {
    mcp,
    loggedIn: async (server) => (server.credential.kind === "oauth" ? (await store.load(server.name)) !== null : true),
    async startLogin(server) {
      const state = randomBytes(16).toString("hex");
      const provider = providerFor(server, state);
      const result = await auth(provider, { serverUrl: server.url!, ...(server.credential.kind === "oauth" && server.credential.scopes ? { scope: server.credential.scopes.join(" ") } : {}) });
      if (result === "AUTHORIZED") return { authorizeUrl: null, state };
      // The browser is needed: what is stored stays until the callback stores fresh tokens, so a login nobody finishes logs nothing out.
      logins.set(state, { server: server.name, provider });
      setTimeout(() => logins.delete(state), LOGIN_TTL_MS).unref();
      return { authorizeUrl: provider.pendingAuthorization()?.href ?? null, state };
    },
    async finishLogin(server, code, state) {
      const login = logins.get(state);
      if (!login || login.server !== server.name) throw new Error("no login in progress for that state");
      logins.delete(state);
      await auth(login.provider, { serverUrl: server.url!, authorizationCode: code });
    },
  };
}
