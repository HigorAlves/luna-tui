import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { openTaskIdsOf, pruneLearning } from "./learning-prune.ts";

const NOW = new Date("2026-11-06T12:00:00.000Z");
const dayAgo = (days: number): string => new Date(NOW.getTime() - days * 86_400_000).toISOString().slice(0, 10);

function fixture() {
  const stateDir = mkdtempSync(join(tmpdir(), "prune-"));
  const record = (pack: string, daysOld: number, id: string, extra: Record<string, unknown> = {}, bytes = 0) => {
    const dir = join(stateDir, "decisions", pack, dayAgo(daysOld));
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${id}.json`);
    writeFileSync(path, JSON.stringify({ schema: 1, id, pack, ...extra, pad: "x".repeat(bytes) }));
    return path;
  };
  const truthFile = (kind: string, name: string, daysOld: number) => {
    const dir = join(stateDir, "ground-truth", kind);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, name);
    writeFileSync(path, "{}");
    const when = new Date(NOW.getTime() - daysOld * 86_400_000);
    utimesSync(path, when, when);
    return path;
  };
  return { stateDir, record, truthFile };
}

const base = { retentionDays: 365, maxMb: 0, openTaskIds: new Set<string>(), now: NOW };

describe("pruneLearning by age", () => {
  it("removes records and ground-truth files past the retention and keeps the rest", async () => {
    const f = fixture();
    const old = f.record("risk_score", 400, "old");
    const fresh = f.record("risk_score", 300, "fresh");
    const oldTruth = f.truthFile("plan", "t1-a1.json", 400);
    const freshTruth = f.truthFile("plan", "t2-a2.json", 10);
    const out = await pruneLearning({ stateDir: f.stateDir, ...base });
    expect([existsSync(old), existsSync(fresh), existsSync(oldTruth), existsSync(freshTruth)]).toEqual([false, true, false, true]);
    expect(out).toMatchObject({ records: 1, truthFiles: 1 });
    // The day folder that emptied goes with its last record.
    expect(existsSync(join(f.stateDir, "decisions", "risk_score", dayAgo(400)))).toBe(false);
  });

  it("keeps everything with a retention of 0", async () => {
    const f = fixture();
    const old = f.record("risk_score", 900, "ancient");
    await pruneLearning({ stateDir: f.stateDir, ...base, retentionDays: 0 });
    expect(existsSync(old)).toBe(true);
  });

  it("never removes the record of a card that is still open, whatever its age", async () => {
    const f = fixture();
    const open = f.record("risk_score", 800, "open", { taskId: "task-open" });
    const closed = f.record("risk_score", 800, "closed", { taskId: "task-closed" });
    await pruneLearning({ stateDir: f.stateDir, ...base, openTaskIds: new Set(["task-open"]) });
    expect([existsSync(open), existsSync(closed)]).toEqual([true, false]);
  });

  it("never touches evidence, other folders, or a file that is not <id>.json under a day folder of a pack", async () => {
    const f = fixture();
    const evidence = join(f.stateDir, "evidence");
    mkdirSync(evidence, { recursive: true });
    writeFileSync(join(evidence, "old.json"), "{}");
    utimesSync(join(evidence, "old.json"), new Date("2020-01-01"), new Date("2020-01-01"));
    const other = join(f.stateDir, "pack-runs");
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, "old.json"), "{}");
    const stray = join(f.stateDir, "decisions", "risk_score", dayAgo(500));
    mkdirSync(stray, { recursive: true });
    writeFileSync(join(stray, "notes.txt"), "mine");
    writeFileSync(join(stray, "..hidden.json"), "{}");
    writeFileSync(join(f.stateDir, "decisions", "loose.json"), "{}");
    const odd = join(f.stateDir, "decisions", "risk_score", "not-a-day");
    mkdirSync(odd, { recursive: true });
    writeFileSync(join(odd, "a.json"), "{}");
    await pruneLearning({ stateDir: f.stateDir, ...base });
    for (const path of [join(evidence, "old.json"), join(other, "old.json"), join(stray, "notes.txt"), join(stray, "..hidden.json"), join(f.stateDir, "decisions", "loose.json"), join(odd, "a.json")]) expect(existsSync(path), path).toBe(true);
  });

  it("skips a symbolic link, names it in the log, and never follows it out of the state folder", async () => {
    const f = fixture();
    const outside = mkdtempSync(join(tmpdir(), "outside-"));
    writeFileSync(join(outside, "secret.json"), "{}");
    const day = join(f.stateDir, "decisions", "risk_score", dayAgo(500));
    mkdirSync(day, { recursive: true });
    symlinkSync(join(outside, "secret.json"), join(day, "link.json"));
    mkdirSync(join(f.stateDir, "ground-truth"), { recursive: true });
    symlinkSync(outside, join(f.stateDir, "ground-truth", "plan"));
    const out = await pruneLearning({ stateDir: f.stateDir, ...base });
    expect(existsSync(join(outside, "secret.json"))).toBe(true);
    expect(existsSync(join(day, "link.json"))).toBe(true);
    expect(out.skippedLinks.sort()).toEqual([join(day, "link.json"), join(f.stateDir, "ground-truth", "plan")].sort());
    expect(out.line).toContain("link.json");
  });
});

describe("pruneLearning by size", () => {
  const MB = 1024 * 1024;
  const PAD = Math.floor(MB * 0.9);
  it("removes the records with no truth first, oldest first, until the folder is under the cap", async () => {
    const f = fixture();
    const truthOld = f.record("risk_score", 60, "truth-old", { truth: { label: {}, source: "x", at: "t" } }, PAD);
    const bareOld = f.record("risk_score", 50, "bare-old", {}, PAD);
    const bareNew = f.record("risk_score", 40, "bare-new", {}, PAD);
    const out = await pruneLearning({ stateDir: f.stateDir, ...base, maxMb: 2 });
    expect([existsSync(truthOld), existsSync(bareOld), existsSync(bareNew)]).toEqual([true, false, true]);
    expect(out.records).toBe(1);
    expect(out.freedBytes).toBeGreaterThan(PAD);
    expect(out.line).toMatch(/1 record/);
  });

  it("never removes a record younger than 7 days or one of an open card, even over the cap", async () => {
    const f = fixture();
    const young = f.record("risk_score", 3, "young", {}, MB);
    const open = f.record("risk_score", 90, "open", { taskId: "t" }, MB);
    await pruneLearning({ stateDir: f.stateDir, ...base, maxMb: 1, openTaskIds: new Set(["t"]) });
    expect([existsSync(young), existsSync(open)]).toEqual([true, true]);
  });

  it("removes nothing when under the cap, whatever the age under the retention", async () => {
    const f = fixture();
    const rec = f.record("risk_score", 200, "kept", {}, 1000);
    await pruneLearning({ stateDir: f.stateDir, ...base, maxMb: 10 });
    expect(existsSync(rec)).toBe(true);
  });
});

describe("pruneLearning under a flood", () => {
  const MB = 1024 * 1024;
  const person = { truth: { label: { q: { value: true } }, source: "person_cli", kind: "person", at: "t", history: [{ label: { q: { value: true } }, source: "person_cli", kind: "person", at: "t" }] } };

  it("never removes a record with a person's truth for size, says once that the cap cannot be met, and still removes what it may", async () => {
    const f = fixture();
    const kept = [f.record("risk_score", 30, "p1", person, MB), f.record("risk_score", 40, "p2", person, MB), f.record("risk_score", 50, "p3", person, MB)];
    const bare = f.record("risk_score", 60, "bare", {}, MB);
    const out = await pruneLearning({ stateDir: f.stateDir, ...base, maxMb: 1 });
    expect(kept.map((path) => existsSync(path))).toEqual([true, true, true]);
    expect(existsSync(bare)).toBe(false);
    expect(out.warning).toMatch(/cannot be met/);
    expect(out.warning).not.toContain("\n");
  });

  it("aims at the cap minus the bytes that cannot be pruned: with an open card over the cap it removes every record it may and warns", async () => {
    const f = fixture();
    const open = f.record("risk_score", 90, "open", { taskId: "t" }, 3 * MB);
    const a = f.record("risk_score", 60, "a", {}, 1000);
    const b = f.record("risk_score", 50, "b", {}, 1000);
    const out = await pruneLearning({ stateDir: f.stateDir, ...base, maxMb: 2, openTaskIds: new Set(["t"]) });
    expect([existsSync(open), existsSync(a), existsSync(b)]).toEqual([true, false, false]);
    expect(out.warning).toMatch(/cannot be met/);
  });

  it("says nothing when the cap is met", async () => {
    const f = fixture();
    f.record("risk_score", 60, "a", {}, Math.floor(0.6 * MB));
    f.record("risk_score", 50, "b", {}, Math.floor(0.6 * MB));
    expect((await pruneLearning({ stateDir: f.stateDir, ...base, maxMb: 1 })).warning).toBeNull();
  });

  it("counts the ground-truth folder among the bytes it cannot prune for size", async () => {
    const f = fixture();
    const dir = join(f.stateDir, "ground-truth", "plan");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "big.json"), "x".repeat(2 * MB));
    const bare = f.record("risk_score", 60, "a", {}, 1000);
    const out = await pruneLearning({ stateDir: f.stateDir, ...base, maxMb: 1 });
    expect(existsSync(bare)).toBe(false);
    expect(existsSync(join(dir, "big.json"))).toBe(true);
    expect(out.warning).toMatch(/cannot be met/);
  });

  it("looks again just before it removes: a record given a person's truth after the listing stays", async () => {
    const f = fixture();
    const target = f.record("risk_score", 60, "late", {}, MB);
    const other = f.record("risk_score", 50, "other", {}, MB);
    await pruneLearning({
      stateDir: f.stateDir,
      ...base,
      maxMb: 1,
      afterListing: async () => writeFileSync(target, JSON.stringify({ schema: 1, id: "late", pack: "risk_score", ...person })),
    });
    expect(existsSync(target)).toBe(true);
    expect(JSON.parse(readFileSync(target, "utf8")).truth.kind).toBe("person");
    expect(existsSync(other)).toBe(false);
  });
});

describe("pruneLearning and links, and leftovers", () => {
  it("does not follow a symbolic link standing for the decisions or the ground-truth folder", async () => {
    const f = fixture();
    const outside = mkdtempSync(join(tmpdir(), "outside-"));
    const old = join(outside, "risk_score", dayAgo(500));
    mkdirSync(old, { recursive: true });
    writeFileSync(join(old, "r.json"), "{}");
    mkdirSync(join(outside, "plan"), { recursive: true });
    writeFileSync(join(outside, "plan", "t.json"), "{}");
    utimesSync(join(outside, "plan", "t.json"), new Date("2020-01-01"), new Date("2020-01-01"));
    symlinkSync(outside, join(f.stateDir, "decisions"));
    symlinkSync(outside, join(f.stateDir, "ground-truth"));
    const out = await pruneLearning({ stateDir: f.stateDir, ...base });
    expect(existsSync(join(old, "r.json"))).toBe(true);
    expect(existsSync(join(outside, "plan", "t.json"))).toBe(true);
    expect(out.skippedLinks.sort()).toEqual([join(f.stateDir, "decisions"), join(f.stateDir, "ground-truth")].sort());
  });

  it("removes a stale temporary file of either writer after a day, and keeps a fresh one", async () => {
    const f = fixture();
    const record = f.record("risk_score", 5, "keep", {});
    const day = join(f.stateDir, "decisions", "risk_score", dayAgo(5));
    const staleRecordTmp = join(day, "abc.json.1a2b3c4d.tmp");
    const freshRecordTmp = join(day, "def.json.1a2b3c4d.tmp");
    const truthDir = join(f.stateDir, "ground-truth", "plan");
    mkdirSync(truthDir, { recursive: true });
    const staleTruthTmp = join(truthDir, ".t1-a1.json.123e4567-e89b-12d3-a456-426614174000.tmp");
    for (const path of [staleRecordTmp, freshRecordTmp, staleTruthTmp]) writeFileSync(path, "x");
    const old = new Date(NOW.getTime() - 2 * 86_400_000);
    for (const path of [staleRecordTmp, staleTruthTmp]) utimesSync(path, old, old);
    utimesSync(freshRecordTmp, new Date(NOW.getTime() - 3600_000), new Date(NOW.getTime() - 3600_000));
    await pruneLearning({ stateDir: f.stateDir, ...base });
    expect([existsSync(staleRecordTmp), existsSync(freshRecordTmp), existsSync(staleTruthTmp), existsSync(record)]).toEqual([false, true, false, true]);
  });
});

describe("openTaskIdsOf", () => {
  it("asks for the cards that are neither closed nor archived", async () => {
    const asked: string[] = [];
    const ids = await openTaskIdsOf({ query: async (sql: string) => (asked.push(sql), [{ id: "a" }, { id: "b" }]) });
    expect([...ids]).toEqual(["a", "b"]);
    expect(asked[0]).toMatch(/not in \('closed', 'archived'\)/);
  });
});
