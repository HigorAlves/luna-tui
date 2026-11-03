// The Codex login reaches an eve stage as a per-run copy, and a token the run refreshed comes
// back to the host only when the host file is still the one copied. Temp dirs only: a real
// ~/.codex/auth.json is never read here.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { codexCredentials } from "./codex.ts";

const LOGIN = JSON.stringify({ tokens: { access_token: "old-access", refresh_token: "old-refresh" } });
const REFRESHED = JSON.stringify({ tokens: { access_token: "new-access", refresh_token: "new-refresh" } });

let home: string;
let runDir: string;
let logs: string[];
const hostFile = () => join(home, ".codex", "auth.json");
const mode = (file: string) => statSync(file).mode & 0o777;
const loader = (env: NodeJS.ProcessEnv = {}) => codexCredentials({ env, home, log: (line) => logs.push(line) });

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "codex-home-"));
  runDir = mkdtempSync(join(tmpdir(), "codex-run-"));
  logs = [];
  mkdirSync(join(home, ".codex"));
  writeFileSync(hostFile(), LOGIN, { mode: 0o600 });
});

describe("codexCredentials", () => {
  it("is available with a readable auth.json, and says what is missing without one", async () => {
    expect(await loader().check()).toEqual({ available: true });
    const empty = mkdtempSync(join(tmpdir(), "codex-none-"));
    const none = codexCredentials({ env: {}, home: empty });
    expect(await none.check()).toEqual({ available: false, reason: expect.stringMatching(/no Codex login.*auth\.json.*codex login/) });
    await expect(none.prepare(runDir)).rejects.toThrow(/no Codex login/);
  });

  it("follows CODEX_HOME when it is set", async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), "codex-elsewhere-"));
    writeFileSync(join(elsewhere, "auth.json"), LOGIN);
    const credential = await codexCredentials({ env: { CODEX_HOME: elsewhere }, home: mkdtempSync(join(tmpdir(), "x-")) }).prepare(runDir);
    expect(readFileSync(join(credential.mounts[0]!.host, "auth.json"), "utf8")).toBe(LOGIN);
  });

  it("copies the login into the run's own folder, 0600, mounted writable at /tmp/.codex with CODEX_HOME pointing there", async () => {
    const credential = await loader().prepare(runDir);
    expect(credential.env).toEqual({ CODEX_HOME: "/tmp/.codex" });
    expect(credential.mounts).toEqual([{ host: join(runDir, "codex"), container: "/tmp/.codex", readOnly: false }]);
    const copy = join(runDir, "codex", "auth.json");
    expect(readFileSync(copy, "utf8")).toBe(LOGIN);
    expect(mode(copy)).toBe(0o600);
    expect(mode(join(runDir, "codex"))).toBe(0o700);
  });

  it("leaves the host file alone when the run did not refresh, and deletes the run's copy", async () => {
    const credential = await loader().prepare(runDir);
    await credential.release();
    expect(readFileSync(hostFile(), "utf8")).toBe(LOGIN);
    expect(existsSync(join(runDir, "codex"))).toBe(false);
    expect(logs).toEqual([]);
  });

  it("writes a refreshed token back, 0600, when the host file is still the one copied", async () => {
    const credential = await loader().prepare(runDir);
    writeFileSync(join(runDir, "codex", "auth.json"), REFRESHED);
    await credential.release();
    expect(readFileSync(hostFile(), "utf8")).toBe(REFRESHED);
    expect(mode(hostFile())).toBe(0o600);
    expect(existsSync(join(runDir, "codex"))).toBe(false);
    expect(logs.join("\n")).not.toMatch(/new-access|old-access|refresh_token/);
  });

  it("keeps the host's file, and says so, when it changed while the run held its copy", async () => {
    const credential = await loader().prepare(runDir);
    writeFileSync(join(runDir, "codex", "auth.json"), REFRESHED);
    const relogged = JSON.stringify({ tokens: { access_token: "you-logged-in-again" } });
    writeFileSync(hostFile(), relogged);
    await credential.release();
    expect(readFileSync(hostFile(), "utf8")).toBe(relogged);
    expect(logs).toEqual([expect.stringMatching(/changed meanwhile; kept the host's/)]);
    expect(existsSync(join(runDir, "codex"))).toBe(false);
  });

  it("never writes back a copy that is not JSON (a run killed mid-write)", async () => {
    const credential = await loader().prepare(runDir);
    writeFileSync(join(runDir, "codex", "auth.json"), '{"tokens": {"access');
    await credential.release();
    expect(readFileSync(hostFile(), "utf8")).toBe(LOGIN);
    expect(logs).toEqual([expect.stringMatching(/not JSON; kept the host's/)]);
  });

  it("lets only the first of two runs that refreshed write back: the second finds the host changed", async () => {
    const otherRun = mkdtempSync(join(tmpdir(), "codex-run-"));
    const [a, b] = await Promise.all([loader().prepare(runDir), loader().prepare(otherRun)]);
    writeFileSync(join(runDir, "codex", "auth.json"), REFRESHED);
    writeFileSync(join(otherRun, "codex", "auth.json"), JSON.stringify({ tokens: { access_token: "b" } }));
    await Promise.all([a.release(), b.release()]);
    expect(readFileSync(hostFile(), "utf8")).toBe(REFRESHED);
    expect(logs).toEqual([expect.stringMatching(/wrote it back/), expect.stringMatching(/changed meanwhile/)]);
  });

  it("re-attaching to a running stage keeps the run's copy and what it was copied from", async () => {
    await loader().prepare(runDir);
    writeFileSync(join(runDir, "codex", "auth.json"), REFRESHED);
    // A restart: the container still runs on the copy, and the machine prepares the same run again.
    const again = await loader().prepare(runDir);
    expect(readFileSync(join(runDir, "codex", "auth.json"), "utf8")).toBe(REFRESHED);
    await again.release();
    expect(readFileSync(hostFile(), "utf8")).toBe(REFRESHED);
  });
});
