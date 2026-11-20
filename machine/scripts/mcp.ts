// `pnpm mcp status` lists the machine's MCP servers; `pnpm mcp login <server>` logs one in (RFC 0013).
// Talks to the machine API: MACHINE_URL (default http://localhost:4317), the token from MACHINE_API_TOKEN or ~/.config/hardness/machine-api-token.
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const BASE = (process.env.MACHINE_URL ?? "http://localhost:4317").replace(/\/+$/, "");
const POLL_MS = 2_000;
const LOGIN_MS = 120_000;

function apiToken(): string | null {
  if (process.env.MACHINE_API_TOKEN) return process.env.MACHINE_API_TOKEN;
  try {
    return readFileSync(join(homedir(), ".config", "hardness", "machine-api-token"), "utf8").trim() || null;
  } catch {
    return null;
  }
}

async function api<T>(method: string, path: string): Promise<T> {
  const token = apiToken();
  const res = await fetch(`${BASE}${path}`, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(method === "POST" ? { body: "{}" } : {}) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text.slice(0, 300)}`);
  return JSON.parse(text) as T;
}

type Row = { name: string; transport: string; loggedIn: boolean; tools: string[]; reachable: boolean };
const status = () => api<Row[]>("GET", "/mcp");

function table(rows: Row[]): string {
  const head = ["server", "transport", "logged in", "reachable", "tools"];
  const body = rows.map((r) => [r.name, r.transport, r.loggedIn ? "yes" : "no", r.reachable ? "yes" : "no", r.tools.join(", ")]);
  const width = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i]!.length)));
  return [head, ...body].map((r) => r.map((cell, i) => cell.padEnd(width[i]!)).join("  ").trimEnd()).join("\n");
}

const [command, server] = process.argv.slice(2);
try {
  if (command === "status") {
    const rows = await status();
    console.log(rows.length === 0 ? "no MCP servers declared (see ~/.config/hardness/mcp.yaml)" : table(rows));
  } else if (command === "login" && server) {
    const { authorizeUrl } = await api<{ authorizeUrl: string | null }>("POST", `/mcp/${encodeURIComponent(server)}/login`);
    if (authorizeUrl === null) console.log(`${server}: already logged in`);
    else {
      if (process.platform === "darwin") execFile("open", [authorizeUrl], () => {});
      console.log(`Open this URL to log in to ${server}:\n${authorizeUrl}`);
      const until = Date.now() + LOGIN_MS;
      for (;;) {
        if ((await status()).find((r) => r.name === server)?.loggedIn) break;
        if (Date.now() >= until) throw new Error(`${server}: no login within ${LOGIN_MS / 60_000} minutes`);
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      }
      console.log(`Logged in to ${server}.`);
    }
  } else {
    console.error("usage: pnpm mcp status | pnpm mcp login <server>");
    process.exit(2);
  }
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}
