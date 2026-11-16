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

describe("the approvals of one repository", () => {
  it("lists every reference and Dockerfile key approved for it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bases-"));
    const key = `dockerfile=sha256:${"a".repeat(64)}`;
    try {
      const a = approvedBases(dir);
      expect(await a.list("/r")).toEqual([]);
      await a.approve("/r", "debian:12");
      await a.approve("/r", key);
      await a.approve("/other", "x:1");
      expect(await a.list("/r")).toEqual(["debian:12", key]);
      expect(await a.isApproved("/r", key)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
