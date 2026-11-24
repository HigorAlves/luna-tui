// Each engine gets only its own runtime's credential, from the environment first, then the
// machine's secrets folder. Temp homes only.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EngineId } from "@hardness/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import { credentialsFor, machineCredentials } from "./index.ts";

let home: string;
const secret = (file: string, value: string) => {
  mkdirSync(join(home, ".config", "hardness"), { recursive: true });
  writeFileSync(join(home, ".config", "hardness", file), `${value}\n`);
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "creds-home-"));
});

describe("credentialsFor", () => {
  it("is not configured for any engine on a machine with nothing, and says what each one needs", async () => {
    const credentials = machineCredentials({ env: {}, home });
    const reasons = Object.fromEntries(await Promise.all(EngineId.options.map(async (engine) => [engine, await credentials.check(engine)])));
    expect(reasons["claude:opus"]).toEqual({ available: false, reason: expect.stringMatching(/CLAUDE_CODE_OAUTH_TOKEN/) });
    expect(reasons["codex:sol"]).toEqual({ available: false, reason: expect.stringMatching(/codex login/) });
    expect(reasons["openai:luna"]).toEqual({ available: false, reason: expect.stringMatching(/OPENAI_API_KEY.*openai-api-key/) });
    expect(reasons.jev).toEqual({ available: false, reason: expect.stringMatching(/AI_GATEWAY_API_KEY.*ai-gateway-api-key.*TYPESAFE_API_KEY.*typesafe-api-key/) });
    await expect(credentials.prepare("openai:sol", home)).rejects.toThrow(/no OpenAI API key/);
  });

  it("gives a Claude stage only the Claude variable, the subscription token first, environment over files", async () => {
    secret("claude-oauth-token", "file-token");
    const env = { ANTHROPIC_API_KEY: "sk-key", OPENAI_API_KEY: "sk-openai", TYPESAFE_API_KEY: "ts" };
    expect((await credentialsFor("claude:sonnet", { env, home }).prepare(home)).env).toEqual({ ANTHROPIC_API_KEY: "sk-key" });
    expect((await credentialsFor("claude:haiku", { env: {}, home }).prepare(home)).env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "file-token" });
  });

  it("gives an openai:* stage the OpenAI key and a jev stage the TypeSafe key, from the env or the secrets folder", async () => {
    expect(await credentialsFor("openai:sol", { env: { OPENAI_API_KEY: "sk-env", CLAUDE_CODE_OAUTH_TOKEN: "t" }, home }).prepare(home)).toMatchObject({ env: { OPENAI_API_KEY: "sk-env" }, mounts: [] });
    secret("openai-api-key", "sk-file");
    secret("typesafe-api-key", "ts-file");
    expect((await credentialsFor("openai:luna", { env: {}, home }).prepare(home)).env).toEqual({ OPENAI_API_KEY: "sk-file" });
    expect((await credentialsFor("jev", { env: {}, home }).prepare(home)).env).toEqual({ TYPESAFE_API_KEY: "ts-file" });
    expect(await credentialsFor("jev", { env: {}, home }).check()).toEqual({ available: true });
  });

  it("gives a jev stage one key, the Vercel AI Gateway's first (env, then file), else TypeSafe's", async () => {
    const jev = (env: Record<string, string>) => credentialsFor("jev", { env, home });
    expect((await jev({ AI_GATEWAY_API_KEY: "gw-env", TYPESAFE_API_KEY: "ts-env" }).prepare(home)).env).toEqual({ AI_GATEWAY_API_KEY: "gw-env" });
    expect((await jev({ TYPESAFE_API_KEY: "ts-env" }).prepare(home)).env).toEqual({ TYPESAFE_API_KEY: "ts-env" });
    secret("ai-gateway-api-key", "gw-file");
    expect((await jev({ TYPESAFE_API_KEY: "ts-env" }).prepare(home)).env).toEqual({ AI_GATEWAY_API_KEY: "gw-file" });
    expect((await jev({ AI_GATEWAY_API_KEY: "gw-env" }).prepare(home)).env).toEqual({ AI_GATEWAY_API_KEY: "gw-env" });
    expect(await jev({}).check()).toEqual({ available: true });
  });

  it("refuses a jev stage with neither key, naming both", async () => {
    await expect(credentialsFor("jev", { env: {}, home }).prepare(home)).rejects.toThrow(/no Jev credential: set AI_GATEWAY_API_KEY.*TYPESAFE_API_KEY/);
  });

  it("gives a codex:* stage the run's copy of the Codex login and no Claude token", async () => {
    mkdirSync(join(home, ".codex"));
    writeFileSync(join(home, ".codex", "auth.json"), "{}");
    const runDir = mkdtempSync(join(tmpdir(), "creds-run-"));
    const credential = await credentialsFor("codex:luna", { env: { CLAUDE_CODE_OAUTH_TOKEN: "t" }, home, log: () => {} }).prepare(runDir);
    expect(credential.env).toEqual({ CODEX_HOME: "/tmp/.codex" });
    expect(credential.mounts).toEqual([{ host: join(runDir, "codex"), container: "/tmp/.codex", readOnly: false }]);
    await credential.release();
  });

  it("never answers a value from check", async () => {
    const credentials = machineCredentials({ env: { CLAUDE_CODE_OAUTH_TOKEN: "secret-token", OPENAI_API_KEY: "sk-secret", TYPESAFE_API_KEY: "ts-secret", AI_GATEWAY_API_KEY: "gw-secret" }, home });
    const all = await Promise.all(EngineId.options.map((engine) => credentials.check(engine)));
    expect(JSON.stringify(all)).not.toMatch(/secret/);
  });
});
