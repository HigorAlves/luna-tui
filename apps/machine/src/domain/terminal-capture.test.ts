import { describe, expect, it } from "vitest";

import { checksExcerpt, terminalCapture } from "./terminal-capture.ts";

const checks = [
  { name: "unit", cmd: "pnpm test", ok: true, tail: Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n") },
  { name: "lint", cmd: "pnpm lint", ok: false, tail: "error: unused variable" },
];
const input = {
  scenarios: [{ id: "S1", title: "Total shows", test: null }, { id: "S2", title: "Empty is zero", test: "src/empty.test.ts" }],
  tests: [{ scenario: "S1", before: "fail" as const, after: "pass" as const, file: "src/total.test.ts" }, { scenario: "S2", before: "fail" as const, after: "fail" as const, file: null }],
  checks,
};

describe("terminalCapture", () => {
  it("has one line per scenario with its test file and red to green, then each check's command, last 40 lines and ok or failed", () => {
    const text = terminalCapture(input);
    expect(text).toContain("S1 Total shows src/total.test.ts red → green");
    expect(text).toContain("S2 Empty is zero src/empty.test.ts red → red");
    expect(text).toContain("$ pnpm test");
    expect(text).toContain("line 59");
    expect(text).toContain("line 20");
    expect(text).not.toContain("line 19\n");
    expect(text).toMatch(/unit.*ok/);
    expect(text).toMatch(/lint.*failed/);
  });

  it("redacts token shapes, drops control characters and ANSI, and cuts a line at 400 characters", () => {
    const token = "gh" + "p_" + "a".repeat(36);
    const text = terminalCapture({ ...input, checks: [{ name: "n", cmd: `curl ${token}`, ok: true, tail: `\u001b[31mred\u001b[0m\u0007 bell\n${"x".repeat(900)}` }] });
    expect(text).not.toContain(token);
    expect(text).toContain("[redacted]");
    expect(text).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f]/);
    expect(text).toContain("red bell");
    expect(Math.max(...text.split("\n").map((l) => l.length))).toBeLessThanOrEqual(400);
  });

  it("is at most 64 KiB, and runs nothing", () => {
    const many = Array.from({ length: 400 }, (_, i) => ({ name: `c${i}`, cmd: "x".repeat(300), ok: true, tail: "y".repeat(300) }));
    expect(Buffer.byteLength(terminalCapture({ ...input, checks: many }))).toBeLessThanOrEqual(64 * 1024);
  });

  it("states what it has when there are no scenarios or no checks", () => {
    expect(terminalCapture({ scenarios: [], tests: [], checks: [] })).toMatch(/no scenario|no checks/i);
  });
});

describe("checksExcerpt", () => {
  it("is the last 20 lines of each check", () => {
    const text = checksExcerpt(checks);
    expect(text).toContain("line 59");
    expect(text).toContain("line 40");
    expect(text).not.toContain("line 39\n");
    expect(text).toContain("failed");
  });
});
