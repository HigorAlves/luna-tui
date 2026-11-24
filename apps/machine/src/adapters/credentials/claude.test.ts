import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { claudeCredentials } from "./claude.ts";

// `writeFile` passes through unless a test makes it fail.
const failing = vi.hoisted(() => ({ on: null as null | ((path: string) => boolean) }));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    writeFile: ((path: Parameters<typeof actual.writeFile>[0], ...rest: unknown[]) =>
      failing.on?.(String(path)) ? Promise.reject(new Error("disk full")) : (actual.writeFile as (...a: unknown[]) => Promise<void>)(path, ...rest)) as typeof actual.writeFile,
  };
});

const dirs: string[] = [];
const temp = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "luna-claude-cred-"));
  dirs.push(dir);
  return dir;
};
afterEach(async () => {
  failing.on = null;
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
    expect(credential.relay).toEqual({ kind: "oauth", placeholder, file: join(runDir, "relay", "anthropic"), metaFile: join(runDir, "relay", "meta.json") });
    // The proxy reads the placeholder and the kind from this mounted file, never from its command line.
    expect(JSON.parse(await readFile(credential.relay!.metaFile, "utf8"))).toEqual({ kind: "oauth", placeholder });
    expect((await stat(credential.relay!.metaFile)).mode & 0o777).toBe(0o444);
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

  it("removes the relay folder, and so the real token, when a write fails part-way", async () => {
    const home = await temp();
    const runDir = await temp();
    failing.on = (path) => path.endsWith("meta.json");
    await expect(claudeCredentials({ env: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-real" }, home, engineRelay: true }).prepare(runDir)).rejects.toThrow("disk full");
    await expect(stat(join(runDir, "relay"))).rejects.toThrow();
  });

  it("a prepare for a run that already has its relay folder (a re-attach) keeps the placeholder and the token file, so the running proxy and container still match", async () => {
    const home = await temp();
    const runDir = await temp();
    const loader = claudeCredentials({ env: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-real" }, home, engineRelay: true });
    const first = await loader.prepare(runDir);
    const before = await stat(first.relay!.file);
    const again = await loader.prepare(runDir);
    expect(again.relay).toEqual(first.relay);
    expect(again.env).toEqual(first.env);
    const after = await stat(again.relay!.file);
    expect(after.ino).toBe(before.ino);
    expect(await readFile(again.relay!.file, "utf8")).toBe("sk-ant-oat01-real");
    await again.release();
    await expect(stat(join(runDir, "relay"))).rejects.toThrow();
  });

  it("a re-attach picks up a rotated token in the same file, and replaces a folder it cannot trust", async () => {
    const home = await temp();
    const runDir = await temp();
    const first = await claudeCredentials({ env: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-old" }, home, engineRelay: true }).prepare(runDir);
    const before = await stat(first.relay!.file);
    const rotated = await claudeCredentials({ env: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-new" }, home, engineRelay: true }).prepare(runDir);
    expect(rotated.relay!.placeholder).toBe(first.relay!.placeholder);
    expect(await readFile(rotated.relay!.file, "utf8")).toBe("sk-ant-oat01-new");
    expect((await stat(rotated.relay!.file)).ino).toBe(before.ino);
    expect((await stat(rotated.relay!.file)).mode & 0o777).toBe(0o444);
    // A meta file that does not parse, or of the other kind, is not a run to re-attach to: a new folder, a new placeholder.
    await rm(rotated.relay!.metaFile);
    await writeFile(rotated.relay!.metaFile, "not json");
    const fresh = await claudeCredentials({ env: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-new" }, home, engineRelay: true }).prepare(runDir);
    expect(fresh.relay!.placeholder).not.toBe(first.relay!.placeholder);
    const apiKey = await claudeCredentials({ env: { ANTHROPIC_API_KEY: "sk-ant-api03-k" }, home, engineRelay: true }).prepare(runDir);
    expect(apiKey.relay!.kind).toBe("api-key");
    expect(apiKey.relay!.placeholder).toMatch(/^sk-ant-api03-/);
  });
});
