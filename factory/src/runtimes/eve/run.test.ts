// The eve runner's own pieces, without a server: what the server's environment holds, where the
// run's secrets go, and the luna bridge's token check.
import { statSync } from "node:fs";
import { readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";

import { serveLuna, serverEnv, writeSecrets } from "./run.ts";

const SOURCE = {
  PATH: "/usr/bin",
  HOME: "/tmp",
  CODEX_HOME: "/tmp/.codex",
  GH_TOKEN: "gh-secret",
  GITHUB_TOKEN: "gh-secret-2",
  OPENAI_API_KEY: "sk-secret",
  CLAUDE_CODE_OAUTH_TOKEN: "oauth-secret",
  ANTHROPIC_API_KEY: "ak-secret",
  TYPESAFE_API_KEY: "ts-secret",
  SOME_SERVICE_TOKEN: "x-secret",
  GIT_CONFIG_KEY_0: "safe.directory",
};

describe("serverEnv", () => {
  it("passes the server no credential: they reach it through the secrets file", () => {
    const env = serverEnv(SOURCE, { LUNA_EVE_SECRETS: "/tmp/luna-eve-secrets-x/secrets.json" });
    for (const value of Object.values(env)) expect(value).not.toMatch(/^[a-z-]+-secret(-2)?$/);
    expect(env).toMatchObject({ PATH: "/usr/bin", CODEX_HOME: "/tmp/.codex", GIT_CONFIG_KEY_0: "safe.directory", LUNA_EVE_SECRETS: "/tmp/luna-eve-secrets-x/secrets.json" });
    expect(Object.keys(env).filter((k) => /PASSWORD|BRIDGE_TOKEN/.test(k))).toEqual([]);
  });
});

describe("writeSecrets", () => {
  it("writes the run's secrets to a file only its user can read, in a folder of its own", () => {
    const file = writeSecrets({ password: "pw", bridgeToken: "bt", ghToken: "gh" });
    try {
      expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ password: "pw", bridgeToken: "bt", ghToken: "gh" });
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(dirname(file)).mode & 0o777).toBe(0o700);
    } finally {
      rmSync(dirname(file), { recursive: true, force: true });
    }
  });
});

describe("serveLuna", () => {
  it("answers a call with the run's token and refuses any other", async () => {
    const token = "a".repeat(48);
    const bridge = await serveLuna(async (tool, args) => ({ tool, args }), token);
    try {
      const call = (authorization: string) => fetch(`${bridge.url}/step`, { method: "POST", headers: { authorization, "content-type": "application/json" }, body: '{"label":"x"}' });
      expect(await (await call(`Bearer ${token}`)).json()).toEqual({ tool: "step", args: { label: "x" } });
      expect((await call(`Bearer ${"b".repeat(48)}`)).status).toBe(403);
      expect((await call(`Bearer ${token.slice(1)}`)).status).toBe(403);
      expect((await call("")).status).toBe(403);
    } finally {
      bridge.server.close();
    }
  });
});
