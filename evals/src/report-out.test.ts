import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
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
});
