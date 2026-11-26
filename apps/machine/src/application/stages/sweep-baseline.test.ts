import { describe, expect, it } from "vitest";

import { alsoOnBase, confirmOnBase, failingLinesOf } from "./sweep-baseline.ts";

// DISC-53: develop's own lint has 24 errors in files the card never touched; its unit tests fail in the sandbox on lambdas it does not touch.
const baseLint = ["packages/domain/src/Task/index.ts:8:1 assist/source/organizeImports FIXABLE", "  × The imports and exports are not sorted.", "apps/admin/src/a.ts:3:1 format", "  × Formatter would have printed the following content:", "Checked 900 files in 2.1s. Found 24 errors."].join("\n");

describe("alsoOnBase: a failing check counts as already failing only when the base fails the same way", () => {
  it("is true when every failing line on the card is also in the base's output, timings aside", () => {
    const card = ["packages/domain/src/Task/index.ts:8:1 assist/source/organizeImports FIXABLE", "  × The imports and exports are not sorted.", "Checked 912 files in 2.4s. Found 24 errors."].join("\n");
    expect(alsoOnBase(card, baseLint)).toBe(true);
  });

  it("is false when the card fails on a line the base does not (a lint error in the card's own file hides behind no red base)", () => {
    const card = [baseLint, "apps/lambdas/evaluation/src/app.ts:1:1 format", "  × Formatter would have printed the following content:"].join("\n");
    expect(alsoOnBase(card, baseLint)).toBe(false);
  });

  it("is false when the base passes, or the card names no failing line it could compare", () => {
    expect(alsoOnBase(" FAIL  src/a.test.ts > x", "")).toBe(false);
    expect(alsoOnBase("ERROR run failed", baseLint)).toBe(false);
  });

  it("reads the failing lines of a test runner, durations and counts aside", () => {
    expect(failingLinesOf(" FAIL  src/a.test.ts > x 12ms\nok\n × b 3ms")).toEqual(["FAIL src/a.test.ts > x", "ok | × b"]);
  });
});

describe("confirmOnBase: the sweep's failing checks asked again on the base", () => {
  const checks = [{ name: "lint", run: "yarn lint" }, { name: "admin unit tests", run: "yarn turbo run test:unit" }];
  const lintTail = baseLint;
  const testTail = " FAIL  src/forms/forms.service.test.ts > save\nAssertionError: expected 404 to be 200";
  const outcome = { status: "failed" as const, ran: ["lint", "admin unit tests"], failed: [{ name: "lint", tail: lintTail }, { name: "admin unit tests", tail: testTail }] };

  it("takes a check that fails on the base the same way out of the failures, notes it, and removes the clone; one that passes there still blocks", async () => {
    const removed: string[] = [];
    const ranIn: string[] = [];
    const result = await confirmOnBase(outcome, {
      checks,
      base: async () => "a".repeat(40),
      clone: async () => ({ path: "/clones/base" }),
      remove: async (p) => void removed.push(p),
      run: async (commands, cwd) => (ranIn.push(cwd), { reports: commands.map((c) => (c.name === "lint" ? { name: c.name, ok: false, tail: baseLint } : { name: c.name, ok: true, tail: "" })) }),
    });
    expect(result.failed.map((f) => f.name)).toEqual(["admin unit tests"]);
    expect(result.status).toBe("failed");
    expect(result.redOnBase).toEqual(["lint"]);
    expect(result.note).toMatch(/already failing on the base \(aaaaaaaa\).*lint/);
    expect(ranIn).toEqual(["/clones/base"]);
    expect(removed).toEqual(["/clones/base"]);
  });

  it("passes the sweep when every failure is the base's", async () => {
    const result = await confirmOnBase({ ...outcome, failed: [{ name: "lint", tail: lintTail }] }, { checks, base: async () => "b".repeat(40), clone: async () => ({ path: "/c" }), remove: async () => {}, run: async () => ({ reports: [{ name: "lint", ok: false, tail: baseLint }] }) });
    expect(result).toMatchObject({ status: "passed", failed: [], redOnBase: ["lint"] });
  });

  it("leaves the outcome as it was when the base cannot be asked", async () => {
    const deps = { checks, clone: async () => ({ path: "/c" }), remove: async () => {}, run: async () => ({ reports: [] }) };
    expect(await confirmOnBase(outcome, { ...deps, base: async () => null })).toEqual(outcome);
    expect(await confirmOnBase(outcome, { ...deps, base: async () => "c".repeat(40), clone: async () => Promise.reject(new Error("no clone")) })).toEqual(outcome);
    expect(await confirmOnBase({ status: "passed", ran: ["lint"], failed: [] }, { ...deps, base: async () => "c".repeat(40) })).toEqual({ status: "passed", ran: ["lint"], failed: [] });
  });
});
