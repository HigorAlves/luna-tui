import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { EvidenceStore, safeName, sweepEvidenceStore } from "./evidence-store.ts";

let stateDir: string;
let src: string;
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "evstore-state-"));
  src = mkdtempSync(join(tmpdir(), "evstore-src-"));
});

const DAY = 86_400_000;
const file = (name: string, text = "x") => {
  const path = join(src, name);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
  return path;
};

describe("EvidenceStore.keepText", () => {
  it("writes a text file under the task's folder and answers its path, the name made safe", async () => {
    const store = new EvidenceStore(stateDir);
    const kept = await store.keepText("t1", "abc123", "terminal.txt", "red -> green\n");
    expect(kept).toEqual({ label: "terminal.txt", path: join(stateDir, "evidence", "t1", "abc123", "terminal.txt") });
    expect(readFileSync(kept.path, "utf8")).toBe("red -> green\n");
    const odd = await store.keepText("t1", "abc123", "../../etc/x", "y");
    expect(odd.path.startsWith(join(stateDir, "evidence", "t1", "abc123") + "/")).toBe(true);
  });
});

describe("EvidenceStore", () => {
  it("keeps a task's files under <stateDir>/evidence/<task>/<sha>/", () => {
    expect(new EvidenceStore(stateDir).dirFor("t1", "abc123")).toBe(join(stateDir, "evidence", "t1", "abc123"));
  });

  it("copies regular files, names sanitised, and answers where each one went", async () => {
    const store = new EvidenceStore(stateDir);
    const kept = await store.keep("t1", "abc", [
      { path: file("shot one.png", "png"), label: "shot one.png" },
      { path: file("sub/qa-manifest.json", "{}"), label: "sub/qa-manifest.json" },
    ]);
    const dir = store.dirFor("t1", "abc");
    expect(kept).toEqual([
      { label: "shot one.png", path: join(dir, "shot_one.png"), index: 0 },
      { label: "sub/qa-manifest.json", path: join(dir, "sub_qa-manifest.json"), index: 1 },
    ]);
    expect(readFileSync(kept[0]!.path, "utf8")).toBe("png");
    expect(readdirSync(dir).sort()).toEqual(["shot_one.png", "sub_qa-manifest.json"]);
  });

  it("neutralises a hostile name and keeps two files of one name apart", async () => {
    const store = new EvidenceStore(stateDir);
    const kept = await store.keep("t1", "abc", [
      { path: file("a/x.png", "1"), label: "../../etc/passwd" },
      { path: file("b/x.png", "2"), label: "../../etc/passwd" },
      { path: file("c/.hidden", "3"), label: ".hidden" },
    ]);
    const dir = store.dirFor("t1", "abc");
    for (const k of kept) expect(k.path.startsWith(dir + "/")).toBe(true);
    expect(new Set(kept.map((k) => k.path)).size).toBe(3);
    expect(kept.every((k) => /^[A-Za-z0-9._-]+$/.test(k.path.slice(dir.length + 1)) && !k.path.slice(dir.length + 1).startsWith("."))).toBe(true);
  });

  it("skips what is not a regular file: a symlink, a directory, a missing file, one over the size cap", async () => {
    const store = new EvidenceStore(stateDir, { maxFileBytes: 4 });
    const real = file("real.txt", "abcd");
    symlinkSync(real, join(src, "link.txt"));
    mkdirSync(join(src, "dir"));
    const kept = await store.keep("t1", "abc", [
      { path: real, label: "real.txt" },
      { path: join(src, "link.txt"), label: "link.txt" },
      { path: join(src, "dir"), label: "dir" },
      { path: join(src, "missing"), label: "missing" },
      { path: file("big.bin", "abcde"), label: "big.bin" },
    ]);
    expect(kept.map((k) => k.label)).toEqual(["real.txt"]);
  });

  it("refuses a task id or sha that climbs out of the store", async () => {
    const store = new EvidenceStore(stateDir);
    expect(() => store.dirFor("..", "abc")).toThrow();
    expect(() => store.dirFor("t1", "../x")).toThrow();
    expect(() => store.dirFor("t/1", "abc")).toThrow();
  });

  it("writes pack.json beside the media", async () => {
    const store = new EvidenceStore(stateDir);
    await store.keep("t1", "abc", [{ path: file("a.png"), label: "a.png" }]);
    await store.writePack("t1", "abc", { summary: "s" });
    expect(JSON.parse(readFileSync(join(store.dirFor("t1", "abc"), "pack.json"), "utf8"))).toEqual({ summary: "s" });
  });
});

describe("sweepEvidenceStore", () => {
  const made = (task: string, sha: string, ageDays: number) => {
    const dir = join(stateDir, "evidence", task, sha);
    mkdirSync(dir, { recursive: true });
    const pack = join(dir, "pack.json");
    writeFileSync(pack, "{}");
    const at = new Date(Date.now() - ageDays * DAY);
    utimesSync(pack, at, at);
    return dir;
  };

  it("removes <task>/<sha> dirs whose pack.json is older than the retention, and keeps the newer ones", async () => {
    const old = made("t1", "aaa", 40);
    const fresh = made("t1", "bbb", 2);
    const other = made("t2", "ccc", 100);
    const removed = await sweepEvidenceStore(stateDir, 30, new Date());
    expect(removed).toBe(2);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(other)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(join(stateDir, "evidence", "t2"))).toBe(false);
  });

  it("is off at 0, and quiet when there is no store yet", async () => {
    const old = made("t1", "aaa", 400);
    expect(await sweepEvidenceStore(stateDir, 0, new Date())).toBe(0);
    expect(existsSync(old)).toBe(true);
    expect(await sweepEvidenceStore(mkdtempSync(join(tmpdir(), "evstore-empty-")), 30, new Date())).toBe(0);
  });

  it("asks per task for its retention when given a function: a repo's own value over the machine's", async () => {
    const a = made("keep", "aaa", 40);
    const b = made("drop", "bbb", 40);
    const removed = await sweepEvidenceStore(stateDir, async (task) => (task === "keep" ? 0 : 30), new Date());
    expect(removed).toBe(1);
    expect(existsSync(a)).toBe(true);
    expect(existsSync(b)).toBe(false);
  });
});

describe("safeName", () => {
  it("keeps the extension when it cuts a long name: a 130-character HAR is still a .har", () => {
    const name = safeName("x".repeat(126) + ".har");
    expect(name).toHaveLength(120);
    expect(name.endsWith(".har")).toBe(true);
  });

  it("leaves a short name and a long one with no extension as they were", () => {
    expect(safeName("a b.png")).toBe("a_b.png");
    expect(safeName("y".repeat(200))).toHaveLength(120);
  });
});

describe("EvidenceStore.readPack", () => {
  it("reads the pack the machine kept, and is null for none, for nonsense and for a link", async () => {
    const store = new EvidenceStore(stateDir);
    expect(await store.readPack("t1", "abc1234")).toBeNull();
    const pack = { summary: "s", format: "text", scenarios: [], findings: [], outOfMap: [], risk: "low", rollback: "r", howToVerify: "h", commitSha: "abc1234", media: [{ kind: "video", label: "w.mp4", url: "/local/w.mp4" }], at: "2026-11-03T00:00:00.000Z" };
    await store.writePack("t1", "abc1234", pack);
    expect((await store.readPack("t1", "abc1234"))?.media[0]?.url).toBe("/local/w.mp4");
    await store.writePack("t1", "bad0000", { nope: 1 });
    expect(await store.readPack("t1", "bad0000")).toBeNull();
    const dir = store.dirFor("t1", "link000");
    mkdirSync(dir, { recursive: true });
    symlinkSync(join(store.dirFor("t1", "abc1234"), "pack.json"), join(dir, "pack.json"));
    expect(await store.readPack("t1", "link000")).toBeNull();
  });
});
