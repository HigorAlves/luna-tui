import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { claudeCredentials } from "./claude.ts";

const dirs: string[] = [];
const temp = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "luna-claude-cred-"));
  dirs.push(dir);
  return dir;
};
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("claudeCredentials", () => {
  it("without the relay (MACHINE_ENGINE_RELAY=off) the stage gets the real value as before", async () => {
    const home = await temp();
    const credential = await claudeCredentials({ env: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-real" }, home }).prepare(home);
    expect(credential.env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-real" });
    expect(credential.relay).toBeUndefined();
  });

  it("with the relay a subscription token stays in a 0444 file in a 0700 folder; the stage gets a placeholder of the same kind", async () => {
    const home = await temp();
    const runDir = await temp();
    const credential = await claudeCredentials({ env: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-real" }, home, engineRelay: true }).prepare(runDir);
    expect(Object.keys(credential.env)).toEqual(["CLAUDE_CODE_OAUTH_TOKEN"]);
    const placeholder = credential.env.CLAUDE_CODE_OAUTH_TOKEN!;
    expect(placeholder).toMatch(/^sk-ant-oat01-luna-relay-[0-9a-f]{32}$/);
    expect(JSON.stringify(credential)).not.toContain("sk-ant-oat01-real");
    expect(credential.relay).toEqual({ kind: "oauth", placeholder, file: join(runDir, "relay", "anthropic") });
    expect(await readFile(credential.relay!.file, "utf8")).toBe("sk-ant-oat01-real");
    expect((await stat(credential.relay!.file)).mode & 0o777).toBe(0o444);
    expect((await stat(join(runDir, "relay"))).mode & 0o777).toBe(0o700);
    await credential.release();
    await expect(stat(join(runDir, "relay"))).rejects.toThrow();
  });

  it("with the relay an API key becomes an API-key placeholder, and each run's placeholder is its own", async () => {
    const home = await temp();
    const loader = claudeCredentials({ env: { ANTHROPIC_API_KEY: "sk-ant-api03-real" }, home, engineRelay: true });
    const a = await loader.prepare(await temp());
    const b = await loader.prepare(await temp());
    expect(a.relay!.kind).toBe("api-key");
    expect(a.env.ANTHROPIC_API_KEY).toMatch(/^sk-ant-api03-luna-relay-[0-9a-f]{32}$/);
    expect(a.env.ANTHROPIC_API_KEY).not.toBe(b.env.ANTHROPIC_API_KEY);
    await Promise.all([a.release(), b.release()]);
  });
});
