// The stage-local sandbox runs eve's own scripts (glob, grep, job bookkeeping) as children of the
// eve server. The server's environment holds the stage's credentials; no script may inherit one.
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { connect, storePath } from "./sandbox.ts";

const CREDENTIALS = {
  CLAUDE_CODE_OAUTH_TOKEN: "oauth-secret",
  ANTHROPIC_API_KEY: "anthropic-secret",
  OPENAI_API_KEY: "openai-secret",
  CODEX_HOME: "/tmp/.codex",
  AI_GATEWAY_API_KEY: "gateway-secret",
  TYPESAFE_API_KEY: "typesafe-secret",
};

afterEach(() => vi.unstubAllEnvs());

describe("stage-local sandbox command env", () => {
  it("carries no credential variable, even when the server holds them all", async () => {
    for (const [name, value] of Object.entries(CREDENTIALS)) vi.stubEnv(name, value);
    const root = mkdtempSync(join(tmpdir(), "luna-sandbox-"));
    const child = await connect(root).spawn({ command: "env", env: {}, workingDirectory: root, signal: new AbortController().signal });
    const out = await new Response(child.stdout).text();
    await child.wait();
    const names = out.split("\n").map((line) => line.split("=")[0]);
    for (const name of Object.keys(CREDENTIALS)) expect(names).not.toContain(name);
    for (const value of Object.values(CREDENTIALS)) expect(out).not.toContain(value);
    // The probe ran: the explicit env is there.
    expect(names).toContain("PATH");
  });
});

describe("eve's attachments", () => {
  const made: string[] = [];
  afterEach(() =>
    made.splice(0).forEach((d) => {
      chmodSync(d, 0o755);
      rmSync(d, { recursive: true, force: true });
    }),
  );
  const fresh = () => {
    const d = mkdtempSync(join(tmpdir(), "eve-sbx-"));
    made.push(d);
    return d;
  };

  it("maps only <root>/.eve/attachments into the store", () => {
    expect(storePath("/work", "/work/.eve/attachments/ab/x.png", "/tmp/s/attachments")).toBe("/tmp/s/attachments/ab/x.png");
    expect(storePath("/work", "/work/.eve/traces/t.json", "/tmp/s/attachments")).toBe("/work/.eve/traces/t.json");
    expect(storePath("/work", "/work/src/a.ts", "/tmp/s/attachments")).toBe("/work/src/a.ts");
    expect(storePath("/work", "/work/.eve/attachments/ab/x.png", undefined)).toBe("/work/.eve/attachments/ab/x.png");
  });

  it("does not let a .. segment climb out of the attachments prefix", () => {
    expect(storePath("/work", "/work/.eve/attachments/../../etc/x", "/tmp/s/attachments")).toBe("/work/.eve/attachments/../../etc/x");
  });

  it("stores an attachment though the worktree is read-only, and reads it back", async () => {
    const root = fresh();
    const store = join(fresh(), "attachments");
    chmodSync(root, 0o555);
    const sandbox = connect(root, store);
    const path = join(root, ".eve", "attachments", "ab", "x.png");
    await sandbox.writeFiles({ files: [{ path, content: new Uint8Array([1, 2, 3]) }] } as never);
    expect(readFileSync(join(store, "ab", "x.png"))).toEqual(Buffer.from([1, 2, 3]));
    expect(existsSync(join(root, ".eve"))).toBe(false);
    expect(Buffer.from((await sandbox.readFile({ path } as never)) as Uint8Array)).toEqual(Buffer.from([1, 2, 3]));
    await sandbox.removePath({ path: join(root, ".eve", "attachments", "ab"), recursive: true } as never);
    expect(existsSync(join(store, "ab"))).toBe(false);
  });
});
