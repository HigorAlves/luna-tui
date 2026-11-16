import { describe, expect, it } from "vitest";

import { LOCKFILES, compareEnv, envHash, envOf } from "./env-hash.ts";

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

describe("LOCKFILES", () => {
  it("names the lockfiles of npm, pnpm, yarn, bun, Cargo, Go, Poetry, uv, Pipfile, Gemfile and composer", () => {
    for (const name of ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb", "Cargo.lock", "go.sum", "poetry.lock", "uv.lock", "Pipfile.lock", "Gemfile.lock", "composer.lock"]) expect(LOCKFILES).toContain(name);
  });
});

describe("compareEnv", () => {
  const recorded = envOf(LOCKED);
  it("matches the same image and lockfiles", () => {
    expect(compareEnv(recorded, envOf(LOCKED))).toEqual({ matched: true, differences: [], notes: [] });
  });

  it("notes a different image with both values but does not call it a mismatch: Verify runs its own checks in the image it has", () => {
    const out = compareEnv(recorded, envOf({ ...LOCKED, image: "sha256:new" }));
    expect(out).toEqual({ matched: true, differences: [], notes: ["the runner image differs: Build ran on sha256:abc, Verify on sha256:new"] });
  });

  it("still fails on a lockfile that differs when the image differs too", () => {
    const out = compareEnv(recorded, envOf({ ...LOCKED, image: "sha256:new", lockfiles: { ...LOCKED.lockfiles, "Cargo.lock": "h9" } }));
    expect(out.matched).toBe(false);
    expect(out.notes).toHaveLength(1);
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
