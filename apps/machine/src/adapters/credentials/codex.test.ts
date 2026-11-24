// The Codex login reaches an eve stage as a per-run copy, and a token the run refreshed comes
// back to the host only when the host file is still the one copied. Temp dirs only: a real
// ~/.codex/auth.json is never read here.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { CodexLease, codexCredentials, removeStaleCodexTemps } from "./codex.ts";
import { CredentialWaitError } from "./credential.ts";

// A rename that fails once on demand: the write-back must not leave its temp file behind.
const failRename = vi.hoisted(() => ({ next: false }));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (from: string, to: string) => {
      if (failRename.next) {
        failRename.next = false;
        throw Object.assign(new Error("EXDEV: cross-device link not permitted"), { code: "EXDEV" });
      }
      return actual.rename(from, to);
    },
  };
});

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
    // Two machines' worth of leases: each run holds its own, so both copy the same token.
    const otherRun = mkdtempSync(join(tmpdir(), "codex-run-"));
    const [a, b] = await Promise.all([
      codexCredentials({ env: {}, home, log: (line) => logs.push(line) }, new CodexLease()).prepare(runDir),
      codexCredentials({ env: {}, home, log: (line) => logs.push(line) }, new CodexLease()).prepare(otherRun),
    ]);
    writeFileSync(join(runDir, "codex", "auth.json"), REFRESHED);
    writeFileSync(join(otherRun, "codex", "auth.json"), JSON.stringify({ tokens: { access_token: "b", refresh_token: "b" } }));
    await Promise.all([a.release(), b.release()]);
    expect(readFileSync(hostFile(), "utf8")).toBe(REFRESHED);
    expect(logs).toEqual([expect.stringMatching(/wrote it back/), expect.stringMatching(/changed meanwhile/)]);
  });

  it("re-attaching to a running stage keeps the run's copy and what it was copied from", async () => {
    await loader().prepare(runDir);
    writeFileSync(join(runDir, "codex", "auth.json"), REFRESHED);
    // A restart: the container still runs on the copy, and the new machine prepares the same run again.
    const again = await codexCredentials({ env: {}, home, log: (line) => logs.push(line) }, new CodexLease()).prepare(runDir);
    expect(readFileSync(join(runDir, "codex", "auth.json"), "utf8")).toBe(REFRESHED);
    await again.release();
    expect(readFileSync(hostFile(), "utf8")).toBe(REFRESHED);
  });

  it("runs one Codex run at a time: the second copies the login only once the first wrote its refresh back", async () => {
    const otherRun = mkdtempSync(join(tmpdir(), "codex-run-"));
    const first = await loader().prepare(runDir);
    const notes: string[] = [];
    let secondReady = false;
    const second = loader()
      .prepare(otherRun, { onWait: (note) => notes.push(note) })
      .then((credential) => {
        secondReady = true;
        return credential;
      });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(secondReady).toBe(false);
    expect(notes).toEqual([expect.stringMatching(/waiting for the Codex login.*another Codex run/)]);

    writeFileSync(join(runDir, "codex", "auth.json"), REFRESHED);
    await first.release();
    const credential = await second;
    // The rotated token, never the one the first run already spent.
    expect(readFileSync(join(otherRun, "codex", "auth.json"), "utf8")).toBe(REFRESHED);
    await credential.release();
    expect(logs).toEqual([expect.stringMatching(/wrote it back/)]);
  });

  it("gives up waiting at the stage's timeout, with a reason, and the queue moves on without it", async () => {
    const first = await loader().prepare(runDir);
    const late = loader().prepare(mkdtempSync(join(tmpdir(), "codex-run-")), { timeoutMs: 20 });
    await expect(late).rejects.toBeInstanceOf(CredentialWaitError);
    await expect(late).rejects.toThrow(/waited .* for the Codex login/);
    const aborted = new AbortController();
    const cancelled = loader().prepare(mkdtempSync(join(tmpdir(), "codex-run-")), { signal: aborted.signal });
    aborted.abort();
    await expect(cancelled).rejects.toThrow(/aborted while waiting for the Codex login/);
    await first.release();
    // Nobody left in the queue: the next run takes the login at once.
    const next = await loader().prepare(mkdtempSync(join(tmpdir(), "codex-run-")), { timeoutMs: 20 });
    await next.release();
  });

  it("gives the login back when preparing the copy fails, so the next run is not stuck behind it", async () => {
    const blocked = join(mkdtempSync(join(tmpdir(), "codex-run-")), "not-a-dir");
    writeFileSync(blocked, "a file where the run folder should be");
    await expect(loader().prepare(blocked)).rejects.toThrow();
    const next = await loader().prepare(runDir, { timeoutMs: 20 });
    await next.release();
  });

  it("never writes back a copy that is not shaped like a Codex login: other top-level keys, or not an object", async () => {
    for (const forged of [JSON.stringify({ tokens: {}, extra: "planted" }), JSON.stringify({ other: 1 }), "[1,2]", '"text"', "null"]) {
      logs = [];
      const credential = await loader().prepare(runDir);
      writeFileSync(join(runDir, "codex", "auth.json"), forged);
      await credential.release();
      expect(readFileSync(hostFile(), "utf8")).toBe(LOGIN);
      expect(logs).toEqual([expect.stringMatching(/not a Codex login.*kept the host's/)]);
    }
  });

  it("never writes back a copy over 64 KB", async () => {
    const credential = await loader().prepare(runDir);
    writeFileSync(join(runDir, "codex", "auth.json"), JSON.stringify({ tokens: { access_token: "x".repeat(70_000) } }));
    await credential.release();
    expect(readFileSync(hostFile(), "utf8")).toBe(LOGIN);
    expect(logs).toEqual([expect.stringMatching(/over 64 KB; kept the host's/)]);
  });

  it("removes its temp file when the write-back fails before the rename, and says so", async () => {
    const credential = await loader().prepare(runDir);
    writeFileSync(join(runDir, "codex", "auth.json"), REFRESHED);
    failRename.next = true;
    await credential.release();
    expect(readFileSync(hostFile(), "utf8")).toBe(LOGIN);
    expect(readdirSync(join(home, ".codex"))).toEqual(["auth.json"]);
    expect(logs).toEqual([expect.stringMatching(/could not write the refreshed login back.*EXDEV/)]);
    expect(existsSync(join(runDir, "codex"))).toBe(false);
  });

  it("removes stale write-back temp files from the Codex home on start, and nothing else", async () => {
    const dir = join(home, ".codex");
    writeFileSync(join(dir, "auth.json.1b2c.tmp"), "half");
    writeFileSync(join(dir, "auth.json.9f.tmp"), "half");
    writeFileSync(join(dir, "config.toml"), "keep");
    writeFileSync(join(dir, "other.tmp"), "keep");
    expect(await removeStaleCodexTemps({ env: {}, home })).toBe(2);
    expect(readdirSync(dir).sort()).toEqual(["auth.json", "config.toml", "other.tmp"]);
    expect(await removeStaleCodexTemps({ env: {}, home: mkdtempSync(join(tmpdir(), "codex-none-")) })).toBe(0);
  });
});
