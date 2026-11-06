import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { pruneRuns } from "./prune-runs.ts";

const NOW = new Date("2026-11-06T12:00:00.000Z");
const stamp = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString().replace(/[:.]/g, "-");

describe("pruneRuns", () => {
  it("removes stamped run folders older than the days given, keeps newer ones, and skips links and anything not stamped", () => {
    const dir = mkdtempSync(join(tmpdir(), "runs-"));
    const outside = mkdtempSync(join(tmpdir(), "outside-"));
    writeFileSync(join(outside, "keep.txt"), "x");
    for (const name of [stamp(40), stamp(31), stamp(5), "notes", "2026-11-01"]) mkdirSync(join(dir, name, "claude-haiku"), { recursive: true });
    symlinkSync(outside, join(dir, stamp(90)));
    writeFileSync(join(dir, stamp(60)), "a file named like a stamp");
    const out = pruneRuns(dir, { olderThanDays: 30, now: NOW });
    expect(out.removed.sort()).toEqual([stamp(31), stamp(40)].sort());
    expect(existsSync(join(dir, stamp(5)))).toBe(true);
    expect(existsSync(join(dir, "notes"))).toBe(true);
    expect(existsSync(join(dir, "2026-11-01"))).toBe(true);
    expect(existsSync(join(outside, "keep.txt"))).toBe(true);
    expect(existsSync(join(dir, stamp(90)))).toBe(true);
    expect(existsSync(join(dir, stamp(60)))).toBe(true);
    expect(out.skipped.length).toBeGreaterThan(0);
  });

  it("does nothing for a folder that is not there", () => {
    expect(pruneRuns(join(tmpdir(), "no-such-runs-folder"), { olderThanDays: 30, now: NOW })).toEqual({ removed: [], skipped: [] });
  });
});
