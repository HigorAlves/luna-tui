import type { CheckSpec } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import { runChecks, runSweep, selectSweep } from "./sweep.ts";

const check = (name: string, over: Partial<CheckSpec> = {}): CheckSpec => ({ name, run: `run-${name}`, ...over });
const names = (list: CheckSpec[]) => list.map((c) => c.name);

describe("selectSweep", () => {
  const checks = [
    check("unit-web", { paths: ["web/**"] }),
    check("unit-api", { paths: ["api/**"] }),
    check("full-suite", { minutes: 8 }),
    check("slow-suite", { minutes: 45 }),
    check("unmarked-suite"),
    check("lint"),
    check("typecheck"),
    check("format"),
  ];

  it("takes the checks whose paths cover a changed file or a file the graph names for it", () => {
    expect(names(selectSweep(checks, ["web/a.ts"], [], 10))).toEqual(expect.arrayContaining(["unit-web"]));
    expect(names(selectSweep(checks, ["web/a.ts"], [], 10))).not.toContain("unit-api");
    expect(names(selectSweep(checks, ["web/a.ts"], ["api/b.ts"], 10))).toEqual(expect.arrayContaining(["unit-web", "unit-api"]));
  });

  it("adds a whole-suite check only when its minutes hint is within the limit, and lint, typecheck and format always", () => {
    const picked = names(selectSweep(checks, ["web/a.ts"], [], 10));
    expect(picked).toEqual(["unit-web", "full-suite", "lint", "typecheck", "format"]);
    expect(names(selectSweep(checks, ["web/a.ts"], [], 60))).toContain("slow-suite");
  });

  it("keeps every check with paths when the change is unknown", () => {
    expect(names(selectSweep(checks, null, [], 10))).toEqual(expect.arrayContaining(["unit-web", "unit-api"]));
  });
});

const ok = { code: 0, stdout: "fine", stderr: "" };
describe("runChecks", () => {
  it("runs each command, reports its exit and tail, and notes a missing tool (exit 127) separately", async () => {
    const out = await runChecks({
      commands: [{ name: "a", cmd: "a", argv: ["sh", "-c", "a"] }, { name: "b", cmd: "b", argv: ["sh", "-c", "b"] }],
      exec: async (_c, args) => (args[1] === "b" ? { code: 127, stdout: "", stderr: "b: not found" } : ok),
      cwd: "/w",
      env: {},
      stage: "implementing",
      timeoutMs: 60_000,
    });
    expect(out.reports).toEqual([{ name: "a", cmd: "a", ok: true, tail: "fine" }, { name: "b", cmd: "b", ok: false, tail: "b: not found" }]);
    expect(out.missingTool).toMatchObject({ cmd: "b" });
    expect(out.aborted).toBe(false);
  });

  it("stops and says aborted when the stage's signal aborts", async () => {
    const controller = new AbortController();
    const out = await runChecks({ commands: [{ name: "a", cmd: "a", argv: ["a"] }], exec: async () => (controller.abort(), ok), cwd: "/w", env: {}, stage: "implementing", timeoutMs: 1000, signal: controller.signal });
    expect(out.aborted).toBe(true);
  });
});

describe("runSweep", () => {
  const base = (over: Record<string, unknown> = {}) => ({
    exec: async () => ok,
    changedPaths: async () => ["web/a.ts"],
    impact: async () => ["api/b.ts"],
    policy: async () => ({ checks: [check("unit-web", { paths: ["web/**"] }), check("lint")] as CheckSpec[] | null, services: {}, wholeSuiteMinutes: 10 }),
    ...over,
  });
  const input = { worktree: "/w", repoPath: "/r", signal: new AbortController().signal, env: {} };

  it("passes when every selected check is green and names what ran", async () => {
    expect(await runSweep(base(), input)).toMatchObject({ status: "passed", ran: ["unit-web", "lint"], failed: [] });
  });

  it("fails with the failing check's name and the tail of its output", async () => {
    const exec = async (_c: string, args: string[]) => (args[1]!.includes("lint") ? { code: 1, stdout: "", stderr: "lint: unexpected var" } : ok);
    expect(await runSweep(base({ exec }), input)).toMatchObject({ status: "failed", failed: [{ name: "lint", tail: "lint: unexpected var" }] });
  });

  it("skips, and says so, for a repo with no checks", async () => {
    const out = await runSweep(base({ policy: async () => ({ checks: null, services: {}, wholeSuiteMinutes: 10 }) }), input);
    expect(out).toMatchObject({ status: "skipped", ran: [], note: expect.stringMatching(/no checks/) });
  });

  it("asks the graph about the changed files, and carries on without it", async () => {
    const seen: string[][] = [];
    await runSweep(base({ impact: async (_r: string, files: string[]) => (seen.push(files), []) }), input);
    expect(seen).toEqual([["web/a.ts"]]);
    expect(await runSweep(base({ impact: async () => { throw new Error("no graph"); } }), input)).toMatchObject({ status: "passed" });
  });
});

describe("runChecks and what a check was refused", () => {
  it("hands the rows a check's container was refused to onBlocked, with the check's name", async () => {
    const rows = [{ host: "evil.example.com", port: 443, via: "connect" as const, reason: "not_listed", count: 2 }];
    const seen: Array<[string, unknown]> = [];
    await runChecks({ commands: [{ name: "unit", cmd: "t", argv: ["t"] }, { name: "lint", cmd: "l", argv: ["l"] }], exec: async (cmd) => ({ code: 0, stdout: "", stderr: "", ...(cmd === "t" ? { blocked: rows } : {}) }), cwd: "/w", env: {}, stage: "implementing", timeoutMs: 10_000, onBlocked: (name, found) => void seen.push([name, found]) });
    expect(seen).toEqual([["unit", rows]]);
  });
});
