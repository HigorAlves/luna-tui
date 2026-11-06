import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { writeReport } from "./report-out.ts";

describe("writeReport", () => {
  it("writes nothing without --out, and exactly the file named with it", () => {
    const dir = mkdtempSync(join(tmpdir(), "out-"));
    expect(writeReport(undefined, ["a"])).toBeNull();
    expect(readdirSync(dir)).toEqual([]);
    const file = join(dir, "report.txt");
    expect(writeReport(file, ["a", "b"])).toBe(file);
    expect(readdirSync(dir)).toEqual(["report.txt"]);
    expect(readFileSync(file, "utf8")).toBe("a\nb\n");
  });

  it("follows no symlink at the path, and sets the mode on every write", () => {
    const dir = mkdtempSync(join(tmpdir(), "out-"));
    const target = join(dir, "elsewhere.txt");
    writeFileSync(target, "mine");
    symlinkSync(target, join(dir, "link.txt"));
    expect(() => writeReport(join(dir, "link.txt"), ["x"])).toThrow();
    expect(readFileSync(target, "utf8")).toBe("mine");
    const file = join(dir, "open.txt");
    writeFileSync(file, "old");
    chmodSync(file, 0o644);
    writeReport(file, ["a"]);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(existsSync(file)).toBe(true);
  });

  it("strips bidirectional and zero-width characters from the lines it writes", () => {
    const dir = mkdtempSync(join(tmpdir(), "out-"));
    const file = join(dir, "r.txt");
    writeReport(file, ["a\u202eb\u200bc"]);
    expect(readFileSync(file, "utf8")).toBe("abc\n");
  });
});
