import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { compareEnv, envHash, envOf, lockfileHashes } from "./env-hash.ts";

// Digests computed by hand with `shasum -a 256` over the documented text.
const LOCKED = { image: "sha256:abc", lockfiles: { "pnpm-lock.yaml": "h1", "Cargo.lock": "h2" }, commit: "c0ffee" };

describe("envHash", () => {
  it("is the sha256 of the image, each lockfile's hash by sorted name, and the commit", () => {
    expect(envHash(LOCKED)).toBe("28024456d539ab851aed29bfe6545b06313427c9ea80dbb0b6898fa2e5317437");
    expect(envHash({ image: "sha256:abc", lockfiles: {}, commit: "c0ffee" })).toBe("8ec36c14cb6a0b2224f612ca2e3b3efd7279f2b3f37ef6f6793990945fa2ddba");
  });

  it("does not depend on the order of the lockfiles, and changes with any input", () => {
    expect(envHash({ ...LOCKED, lockfiles: { "Cargo.lock": "h2", "pnpm-lock.yaml": "h1" } })).toBe(envHash(LOCKED));
    for (const changed of [{ image: "sha256:abd" }, { commit: "c0ffef" }, { lockfiles: { ...LOCKED.lockfiles, "Cargo.lock": "h3" } }]) {
      expect(envHash({ ...LOCKED, ...changed })).not.toBe(envHash(LOCKED));
    }
  });
});

describe("lockfileHashes", () => {
  it("hashes the lockfiles the repository has, by name, and nothing else", () => {
    const dir = mkdtempSync(join(tmpdir(), "env-"));
    writeFileSync(join(dir, "pnpm-lock.yaml"), "hello");
    writeFileSync(join(dir, "package.json"), "{}");
    mkdirSync(join(dir, "Cargo.lock"));
    expect(lockfileHashes(dir)).toEqual({ "pnpm-lock.yaml": "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824" });
  });
});

describe("compareEnv", () => {
  const recorded = envOf(LOCKED);
  it("matches the same image and lockfiles", () => {
    expect(compareEnv(recorded, envOf(LOCKED))).toEqual({ matched: true, differences: [] });
  });

  it("names a different image with both values", () => {
    const out = compareEnv(recorded, envOf({ ...LOCKED, image: "sha256:new" }));
    expect(out).toEqual({ matched: false, differences: ["the runner image differs: Build ran on sha256:abc, Verify on sha256:new"] });
  });

  it("names a lockfile that differs at the same commit, but not at another commit", () => {
    const changed = { ...LOCKED, lockfiles: { ...LOCKED.lockfiles, "Cargo.lock": "h9" } };
    expect(compareEnv(recorded, envOf(changed)).differences).toEqual(["Cargo.lock differs at the same commit: Build recorded h2, Verify has h9"]);
    expect(compareEnv(recorded, envOf({ ...changed, commit: "other" })).matched).toBe(true);
  });

  it("names a lockfile that appeared or vanished at the same commit", () => {
    const out = compareEnv(recorded, envOf({ ...LOCKED, lockfiles: { "pnpm-lock.yaml": "h1" } }));
    expect(out.differences).toEqual(["Cargo.lock differs at the same commit: Build recorded h2, Verify has none"]);
  });
});
