import { describe, expect, it } from "vitest";

import { fixGuard } from "./fix-guard.ts";

const ok = { scope: "in_place" as const, changed: ["src/a.ts"], prFiles: ["src/a.ts", "src/b.ts"], added: 5, removed: 2 };

describe("fixGuard: a fix stays inside the card's own change", () => {
  it("lets a fix touch the PR's own files and test files", () => {
    expect(fixGuard(ok)).toEqual({ ok: true });
    expect(fixGuard({ ...ok, changed: ["src/a.ts", "src/new.test.ts"] })).toEqual({ ok: true });
  });
  it("refuses a file the PR does not already change, naming it", () => {
    expect(fixGuard({ ...ok, changed: ["src/a.ts", "src/other.ts"] })).toEqual({ ok: false, reason: expect.stringContaining("src/other.ts"), paths: ["src/other.ts"] });
  });
  it("refuses a control-plane path even when the PR already changes it", () => {
    const r = fixGuard({ ...ok, changed: [".github/workflows/ci.yml"], prFiles: [".github/workflows/ci.yml"] });
    expect(r).toMatchObject({ ok: false, paths: [".github/workflows/ci.yml"] });
    expect(fixGuard({ ...ok, changed: ["pnpm-lock.yaml"], prFiles: ["pnpm-lock.yaml"] }).ok).toBe(false);
  });
  it("sizes in_place at 10 files and 200 lines, re_verify_partial at 30 and 600", () => {
    const files = Array.from({ length: 11 }, (_, i) => `src/f${i}.ts`);
    expect(fixGuard({ scope: "in_place", changed: files, prFiles: files, added: 1, removed: 1 }).ok).toBe(false);
    expect(fixGuard({ scope: "in_place", changed: files.slice(0, 10), prFiles: files, added: 100, removed: 100 }).ok).toBe(true);
    expect(fixGuard({ scope: "in_place", changed: files.slice(0, 10), prFiles: files, added: 100, removed: 101 }).ok).toBe(false);
    const many = Array.from({ length: 30 }, (_, i) => `src/g${i}.ts`);
    expect(fixGuard({ scope: "re_verify_partial", changed: many, prFiles: many, added: 300, removed: 300 }).ok).toBe(true);
    expect(fixGuard({ scope: "re_verify_partial", changed: many, prFiles: many, added: 300, removed: 301 }).ok).toBe(false);
  });
});
