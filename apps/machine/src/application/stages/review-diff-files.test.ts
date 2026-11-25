import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { parseDiff } from "./review-diff.ts";
import { removeDiffFiles, writeDiffFiles } from "./review-diff-files.ts";

const sec = (path: string) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n+x\n`;

describe("a big PR's diff as files", () => {
  it("writes one .diff per file under its directories and all.diff, and removes the folder", async () => {
    const state = mkdtempSync(join(tmpdir(), "prdiff-"));
    const files = parseDiff(sec("src/a/b.ts") + sec("top.ts"));
    const { host } = await writeDiffFiles(state, "r1", files, files.map((f) => f.text).join(""));
    expect(host).toBe(join(state, "runs", "r1-prdiff"));
    expect(readFileSync(join(host, "src/a/b.ts.diff"), "utf8")).toBe(sec("src/a/b.ts"));
    expect(readFileSync(join(host, "top.ts.diff"), "utf8")).toBe(sec("top.ts"));
    expect(readFileSync(join(host, "all.diff"), "utf8")).toContain("top.ts");
    await removeDiffFiles(host);
    expect(existsSync(host)).toBe(false);
  });

  it("never writes outside its folder, whatever a path says", async () => {
    const state = mkdtempSync(join(tmpdir(), "prdiff-"));
    const files = parseDiff(sec("../../escape.ts"));
    const { host } = await writeDiffFiles(state, "r2", files, "");
    expect(existsSync(join(host, "escape.ts.diff"))).toBe(true);
    expect(existsSync(join(state, "escape.ts.diff"))).toBe(false);
  });
});
