import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_POLICY } from "../domain/policy.ts";
import { POLICY_FILE, PolicyStore } from "./policy.ts";

const dirs: string[] = [];
const repo = () => {
  const dir = mkdtempSync(join(tmpdir(), "policy-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("PolicyStore", () => {
  it("is the defaults for a repo with no file, and for no repo at all", async () => {
    const store = new PolicyStore();
    expect(await store.for(repo())).toEqual(DEFAULT_POLICY);
    expect(await store.for(null)).toEqual(DEFAULT_POLICY);
  });

  it("reads the file, and sees an edit without a restart", async () => {
    const dir = repo();
    writeFileSync(join(dir, POLICY_FILE), "---\nqa: none\n---\n");
    const store = new PolicyStore();
    expect((await store.for(dir)).qa).toBe("none");
    writeFileSync(join(dir, POLICY_FILE), "---\nqa: web\nmax_concurrent: 2\n---\n");
    expect(await store.for(dir)).toMatchObject({ qa: "web", maxConcurrent: 2 });
  });

  it("keeps the last good policy when the file goes bad, and says so once", async () => {
    const dir = repo();
    writeFileSync(join(dir, POLICY_FILE), "---\nmax_concurrent: 2\n---\n");
    const warnings: string[] = [];
    const store = new PolicyStore({ warn: (message) => warnings.push(message) });
    expect((await store.for(dir)).maxConcurrent).toBe(2);
    writeFileSync(join(dir, POLICY_FILE), "---\nmax_concurrent: lots\n---\n");
    expect((await store.for(dir)).maxConcurrent).toBe(2);
    expect((await store.for(dir)).maxConcurrent).toBe(2);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/PIPELINE\.md.*max_concurrent must be a positive integer.*keeping the last good/);
  });

  it("falls back to the defaults when the first read is already bad", async () => {
    const dir = repo();
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, POLICY_FILE), "---\nqa: mobile\n---\n");
    const store = new PolicyStore({ warn: () => {} });
    expect(await store.for(dir)).toEqual(DEFAULT_POLICY);
  });
});
