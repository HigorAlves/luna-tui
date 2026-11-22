import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { fileTokenStore, lunaOAuthProvider, McpCredentialError, resolvedRefSecrets, tokenFor } from "./tokens.ts";

const dir = () => mkdtempSync(join(tmpdir(), "mcp-tokens-"));
const server = (credential: unknown) => ({ name: "figma", transport: "http", url: "https://x.dev/mcp", credential, tools: [] }) as never;

describe("fileTokenStore", () => {
  it("writes <dir>/mcp/<server>.json with mode 0600, reads it back, and answers null for a missing file", async () => {
    const d = dir();
    const store = fileTokenStore(d);
    expect(await store.load("figma")).toBeNull();
    await store.save("figma", { access_token: "tok-aaaaaaaaaaaa", token_type: "Bearer" });
    const file = join(d, "mcp", "figma.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(await store.load("figma")).toEqual({ access_token: "tok-aaaaaaaaaaaa", token_type: "Bearer" });
  });

  it("keeps the client information, secret included, in <server>.client.json at 0600, and removes both", async () => {
    const d = dir();
    const store = fileTokenStore(d);
    await store.saveClient("figma", { client_id: "cid", client_secret: "sec-bbbbbbbbbbbb" } as never);
    const file = join(d, "mcp", "figma.client.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf8")).client_secret).toBe("sec-bbbbbbbbbbbb");
    expect(await store.loadClient("figma")).toMatchObject({ client_id: "cid" });
    await store.save("figma", { access_token: "t", token_type: "Bearer" });
    await store.remove("figma");
    expect(await store.load("figma")).toBeNull();
    expect(await store.loadClient("figma")).toBeNull();
  });
});

describe("tokenFor", () => {
  const exec = async (_file: string, args: string[]) => (args[1] === "op://v/i/f" ? "  from-op\n" : Promise.reject(new Error("exit 1 secret-should-not-show")));
  it("resolves none, env:, literal: and op:// refs", async () => {
    const t = tokenFor(fileTokenStore(dir()), { FOO: "env-value" }, exec);
    expect(await t(server({ kind: "none" }))).toBeNull();
    expect(await t(server({ kind: "ref", ref: "env:FOO" }))).toBe("env-value");
    expect(await t(server({ kind: "ref", ref: "literal:x" }))).toBe("x");
    expect(await t(server({ kind: "ref", ref: "op://v/i/f" }))).toBe("from-op");
  });
  it("reads env only from the env it is given", async () => {
    process.env.LUNA_MCP_TEST_ONLY = "leak";
    const t = tokenFor(fileTokenStore(dir()), {}, exec);
    await expect(t(server({ kind: "ref", ref: "env:LUNA_MCP_TEST_ONLY" }))).rejects.toBeInstanceOf(McpCredentialError);
    delete process.env.LUNA_MCP_TEST_ONLY;
  });
  it("turns an op failure into a typed error naming the ref and no output", async () => {
    const t = tokenFor(fileTokenStore(dir()), {}, exec);
    const error = await t(server({ kind: "ref", ref: "op://v/missing/f" })).catch((e: unknown) => e as Error);
    expect(error).toBeInstanceOf(McpCredentialError);
    expect((error as Error).message).toContain("op://v/missing/f");
    expect((error as Error).message).not.toContain("secret-should-not-show");
  });
  it("returns the stored access token for oauth, and null when logged out", async () => {
    const store = fileTokenStore(dir());
    const t = tokenFor(store, {}, exec);
    expect(await t(server({ kind: "oauth" }))).toBeNull();
    await store.save("figma", { access_token: "tok-aaaaaaaaaaaa", token_type: "Bearer" });
    expect(await t(server({ kind: "oauth" }))).toBe("tok-aaaaaaaaaaaa");
  });
});

describe("lunaOAuthProvider", () => {
  it("returns what saveTokens stored, keeps the redirect for pendingAuthorization instead of opening it, and registers a client_secret_post client", async () => {
    const store = fileTokenStore(dir());
    const p = lunaOAuthProvider(store, "figma", "http://localhost:4317/mcp/figma/callback");
    expect(p.redirectUrl).toBe("http://localhost:4317/mcp/figma/callback");
    expect(p.clientMetadata).toMatchObject({ client_name: "Luna machine", redirect_uris: ["http://localhost:4317/mcp/figma/callback"], grant_types: ["authorization_code", "refresh_token"], token_endpoint_auth_method: "client_secret_post" });
    expect(await p.tokens()).toBeUndefined();
    await p.saveTokens({ access_token: "tok-aaaaaaaaaaaa", token_type: "Bearer" });
    expect(await p.tokens()).toMatchObject({ access_token: "tok-aaaaaaaaaaaa" });
    await p.saveClientInformation!({ client_id: "cid", client_secret: "sec-bbbbbbbbbbbb" });
    expect(await p.clientInformation()).toMatchObject({ client_id: "cid" });
    await p.saveCodeVerifier("v1");
    expect(await p.codeVerifier()).toBe("v1");
    expect(p.pendingAuthorization()).toBeNull();
    await p.redirectToAuthorization(new URL("https://auth.example/authorize?state=s1"));
    expect(p.pendingAuthorization()?.href).toBe("https://auth.example/authorize?state=s1");
  });
  it("registers with token_endpoint_auth_method none when asked", () => {
    const p = lunaOAuthProvider(fileTokenStore(dir()), "x", "http://localhost/cb", { authMethod: "none" });
    expect(p.clientMetadata.token_endpoint_auth_method).toBe("none");
  });
});

describe("credential refs and redaction", () => {
  it("does not echo an unprefixed ref in the error", async () => {
    const t = tokenFor(fileTokenStore(dir()), {});
    const error = await t(server({ kind: "ref", ref: "sk-live-secretvalue-1234" })).catch((e: unknown) => e as Error);
    expect(error).toBeInstanceOf(McpCredentialError);
    expect((error as Error).message).toBe("credential ref has no env:, literal: or op:// prefix");
  });

  it("records every resolved ref value for redaction", async () => {
    const t = tokenFor(fileTokenStore(dir()), { REF_ENV: "env-secret-value-1" });
    await t(server({ kind: "ref", ref: "literal:literal-secret-value-1" }));
    await t(server({ kind: "ref", ref: "env:REF_ENV" }));
    expect(Object.values(resolvedRefSecrets())).toEqual(expect.arrayContaining(["env-secret-value-1", "literal-secret-value-1"]));
  });
});
