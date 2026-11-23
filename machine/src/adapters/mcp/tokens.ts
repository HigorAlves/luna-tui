// MCP credentials (RFC 0013): the token store in the state dir, the OAuth provider the SDK drives, and the
// one resolver for a `ref` credential. No value is ever logged or put in an error message.
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { McpServerConfig } from "@hardness/contracts";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";

import { McpError } from "../../application/mcp.ts";

/** A `ref` credential that cannot be resolved. The message names the ref, never a value. */
export class McpCredentialError extends McpError {}

export interface TokenStore {
  load(server: string): Promise<OAuthTokens | null>;
  save(server: string, tokens: OAuthTokens): Promise<void>;
  loadClient(server: string): Promise<OAuthClientInformationMixed | null>;
  saveClient(server: string, info: OAuthClientInformationMixed): Promise<void>;
  remove(server: string): Promise<void>;
}

/** Tokens at `<stateDir>/mcp/<server>.json`, the registered client at `<server>.client.json`, both 0600. */
export function fileTokenStore(stateDir: string): TokenStore {
  const root = join(stateDir, "mcp");
  const read = <T>(file: string): T | null => {
    try {
      return JSON.parse(readFileSync(join(root, file), "utf8")) as T;
    } catch {
      return null;
    }
  };
  const write = (file: string, value: unknown): void => {
    mkdirSync(root, { recursive: true });
    const target = join(root, file);
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, target);
  };
  return {
    load: async (server) => read<OAuthTokens>(`${server}.json`),
    save: async (server, tokens) => write(`${server}.json`, tokens),
    loadClient: async (server) => read<OAuthClientInformationMixed>(`${server}.client.json`),
    saveClient: async (server, info) => write(`${server}.client.json`, info),
    remove: async (server) => {
      rmSync(join(root, `${server}.json`), { force: true });
      rmSync(join(root, `${server}.client.json`), { force: true });
    },
  };
}

export interface OAuthProvider extends OAuthClientProvider {
  /** The authorization URL the SDK asked to visit, kept for the login route; nothing is opened. */
  pendingAuthorization(): URL | null;
}

export function lunaOAuthProvider(store: TokenStore, server: string, redirectUrl: string, options: { scope?: string } = {}): OAuthProvider {
  let verifier = "";
  let pending: URL | null = null;
  return {
    get redirectUrl() {
      return redirectUrl;
    },
    get clientMetadata(): OAuthClientMetadata {
      return {
        client_name: "Luna machine",
        redirect_uris: [redirectUrl],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "client_secret_post",
        ...(options.scope ? { scope: options.scope } : {}),
      };
    },
    clientInformation: async () => (await store.loadClient(server)) ?? undefined,
    saveClientInformation: (info) => store.saveClient(server, info),
    tokens: async () => (await store.load(server)) ?? undefined,
    saveTokens: (tokens) => store.save(server, tokens),
    saveCodeVerifier: (v) => {
      verifier = v;
    },
    codeVerifier: () => verifier,
    redirectToAuthorization: (url) => {
      pending = url;
    },
    pendingAuthorization: () => pending,
  };
}

export type Exec = (file: string, args: string[]) => Promise<string>;

const realExec: Exec = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 30_000, maxBuffer: 1 << 20 }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
  });

const resolvedRefs = new Map<string, string>();

/** Every value a `ref` credential has resolved to in this process, for redaction. Keyed by a hash of the ref, as a `literal:` ref holds its value. */
export function resolvedRefSecrets(): Record<string, string> {
  return Object.fromEntries([...resolvedRefs].map(([ref, value]) => [`MCP_REF_${createHash("sha256").update(ref).digest("hex").slice(0, 12).toUpperCase()}`, value]));
}

async function resolveRef(ref: string, env: NodeJS.ProcessEnv, exec: Exec): Promise<string> {
  const value = await resolveRefValue(ref, env, exec);
  resolvedRefs.set(ref, value);
  return value;
}

async function resolveRefValue(ref: string, env: NodeJS.ProcessEnv, exec: Exec): Promise<string> {
  if (ref.startsWith("literal:")) return ref.slice("literal:".length);
  if (ref.startsWith("env:")) {
    const value = env[ref.slice("env:".length)];
    if (!value) throw new McpCredentialError(`${ref}: the variable is not set`);
    return value;
  }
  if (ref.startsWith("op://")) {
    try {
      const out = (await exec("op", ["read", ref])).trim();
      if (!out) throw new Error("empty");
      return out;
    } catch {
      throw new McpCredentialError(`${ref}: op read failed (is the op CLI installed and signed in?)`);
    }
  }
  throw new McpCredentialError("credential ref has no env:, literal: or op:// prefix");
}

/** The token a server's credential gives: null for none and for a logged-out oauth server. */
export function tokenFor(store: TokenStore, env: NodeJS.ProcessEnv, exec: Exec = realExec): (server: McpServerConfig) => Promise<string | null> {
  return async (server) => {
    const c = server.credential;
    if (c.kind === "none") return null;
    if (c.kind === "ref") return resolveRef(c.ref, env, exec);
    return (await store.load(server.name))?.access_token ?? null;
  };
}

/** Every stored MCP access token, refresh token and client secret in `<stateDir>/mcp`, for redaction. */
export function storedMcpSecrets(stateDir: string): Record<string, string> {
  const found: Record<string, string> = {};
  let files: string[] = [];
  try {
    files = readdirSync(join(stateDir, "mcp")).filter((f) => f.endsWith(".json"));
  } catch {
    return found;
  }
  for (const file of files) {
    try {
      const parsed = JSON.parse(readFileSync(join(stateDir, "mcp", file), "utf8")) as Record<string, unknown>;
      for (const key of ["access_token", "refresh_token", "client_secret"]) {
        if (typeof parsed[key] === "string") found[`MCP_${file.replace(/\.json$/, "").toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_${key.toUpperCase()}`] = parsed[key];
      }
    } catch {
      // A file that does not parse holds nothing to name.
    }
  }
  return found;
}
