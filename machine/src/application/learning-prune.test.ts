import { existsSync, mkdirSync, mkdtempSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
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

describe("openTaskIdsOf", () => {
  it("asks for the cards that are neither closed nor archived", async () => {
    const asked: string[] = [];
    const ids = await openTaskIdsOf({ query: async (sql: string) => (asked.push(sql), [{ id: "a" }, { id: "b" }]) });
    expect([...ids]).toEqual(["a", "b"]);
    expect(asked[0]).toMatch(/not in \('closed', 'archived'\)/);
  });
});
