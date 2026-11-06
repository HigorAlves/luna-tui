import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { approvedBases } from "./approved-bases.ts";

describe("the bases a person approved", () => {
  it("keeps the exact reference per repository, across restarts, and nothing else is approved", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bases-"));
    try {
      const a = approvedBases(dir);
      expect(await a.isApproved("/r", "debian:12")).toBe(false);
      await a.approve("/r", "debian:12");
      expect(await a.isApproved("/r", "debian:12")).toBe(true);
      expect(await a.isApproved("/r", "debian:13")).toBe(false);
      expect(await a.isApproved("/other", "debian:12")).toBe(false);
      expect(await approvedBases(dir).isApproved("/r", "debian:12")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads a damaged or linked file as nothing approved", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bases-"));
    try {
      writeFileSync(join(dir, "approved-bases.json"), "{ not json");
      expect(await approvedBases(dir).isApproved("/r", "debian:12")).toBe(false);
      rmSync(join(dir, "approved-bases.json"));
      writeFileSync(join(dir, "elsewhere.json"), JSON.stringify({ "/r": ["debian:12"] }));
      symlinkSync(join(dir, "elsewhere.json"), join(dir, "approved-bases.json"));
      expect(await approvedBases(dir).isApproved("/r", "debian:12")).toBe(false);
      expect(existsSync(join(dir, "elsewhere.json"))).toBe(true);
      expect(readFileSync(join(dir, "elsewhere.json"), "utf8")).toContain("debian");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
