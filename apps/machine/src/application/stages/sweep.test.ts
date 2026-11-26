import type { CheckSpec } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import { SecretsMissingError } from "../../adapters/docker/docker.ts";
import { EgressUnsupportedError } from "../../adapters/docker/egress.ts";
import { InstallFailedError } from "../install.ts";
import { runChecks, runSweep, selectSweep, tailOf } from "./sweep.ts";

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

  it("ignores the graph's impact when every changed file is documentation", () => {
    // The graph ties a README to every source file that mentions it: that is not a reason to run the suite of those files.
    expect(names(selectSweep(checks, [".github/README.md"], ["web/a.ts", "api/b.ts"], 10))).toEqual(["full-suite", "lint", "typecheck", "format"]);
    expect(names(selectSweep(checks, ["docs/a.md", "docs/guide/b.mdx"], ["web/a.ts"], 10))).not.toContain("unit-web");
  });

  it("still takes a check whose paths cover the documentation itself", () => {
    const docsCheck = [check("docs-lint", { paths: ["docs/**"] }), check("unit-web", { paths: ["web/**"] })];
    expect(names(selectSweep(docsCheck, ["docs/a.md"], ["web/a.ts"], 10))).toEqual(["docs-lint"]);
  });

  it("keeps the impact when a code or test file changes beside the documentation", () => {
    expect(names(selectSweep(checks, ["README.md", "web/a.test.ts"], ["api/b.ts"], 10))).toEqual(expect.arrayContaining(["unit-web", "unit-api"]));
    expect(names(selectSweep(checks, ["README.md", "web/a.ts"], ["api/b.ts"], 10))).toEqual(expect.arrayContaining(["unit-web", "unit-api"]));
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

describe("runChecks and the repository's services", () => {
  const services = { postgres: { image: "postgres:16" } };
  const commands = [{ name: "a", cmd: "a", argv: ["a"] }, { name: "b", cmd: "b", argv: ["b"] }, { name: "c", cmd: "c", argv: ["c"] }];

  it("starts them once for the whole pass and removes them at the end, when the exec can open a session", async () => {
    const events: string[] = [];
    const exec = Object.assign(async () => (events.push("exec outside"), ok), {
      session: async () => (events.push("open"), { exec: async (cmd: string) => (events.push(`exec ${cmd}`), ok), close: async () => void events.push("close") }),
    });
    await runChecks({ commands, exec, cwd: "/w", env: {}, services, stage: "implementing", timeoutMs: 10_000 });
    expect(events).toEqual(["open", "exec a", "exec b", "exec c", "close"]);
  });

  it("removes them when a check throws, and when the exec has no session or the repository has no services, runs as before", async () => {
    const events: string[] = [];
    const exec = Object.assign(async () => ok, { session: async () => ({ exec: async () => { throw new Error("no network"); }, close: async () => void events.push("close") }) });
    await expect(runChecks({ commands, exec, cwd: "/w", env: {}, services, stage: "implementing", timeoutMs: 10_000 })).rejects.toThrow("no network");
    expect(events).toEqual(["close"]);
    const plain = await runChecks({ commands, exec: async () => ok, cwd: "/w", env: {}, services, stage: "implementing", timeoutMs: 10_000 });
    expect(plain.reports).toHaveLength(3);
    let opened = 0;
    const idle = Object.assign(async () => ok, { session: async () => (opened++, { exec: async () => ok, close: async () => {} }) });
    await runChecks({ commands, exec: idle, cwd: "/w", env: {}, stage: "implementing", timeoutMs: 10_000 });
    expect(opened).toBe(0);
  });
});

describe("runChecks and secrets", () => {
  it("passes each check only the names it declares: the one that declares none gets none", async () => {
    const seen: Record<string, unknown> = {};
    await runChecks({ commands: [{ name: "db", cmd: "a", argv: ["a"], secrets: ["DB_URL"] }, { name: "plain", cmd: "b", argv: ["b"], secrets: [] }], exec: async (cmd, _a, options) => ((seen[cmd] = (options as { secrets?: string[] }).secrets), { code: 0, stdout: "", stderr: "" }), cwd: "/w", env: {}, stage: "implementing", timeoutMs: 10_000 });
    expect(seen).toEqual({ a: ["DB_URL"], b: undefined });
  });
});

describe("runSweep when the environment cannot run a check", () => {
  const policy = async () => ({ checks: [{ name: "lint", run: "x", secrets: ["DB_URL"] }], services: {}, wholeSuiteMinutes: 10 });
  const sweep = (error: Error) => runSweep({ exec: async () => { throw error; }, changedPaths: async () => null, impact: async () => [], policy }, { worktree: "/w", repoPath: "/r", env: {} });

  it("returns an escalation with the step and the reason for a failed install, a missing secret and a daemon without the isolated network", async () => {
    const install = { escalation: "env_broken", envBroken: true, step: "install", tool: "npm", reason: "x", logTail: "t", options: [] };
    expect(await sweep(new InstallFailedError(install))).toMatchObject({ status: "failed", escalated: install });
    const secret = await sweep(new SecretsMissingError([{ name: "DB_URL", reason: "there is no such file" }], "/f"));
    expect(secret.escalated).toMatchObject({ escalation: "env_broken", step: "secrets", names: ["DB_URL"] });
    expect((await sweep(new EgressUnsupportedError("old"))).escalated).toMatchObject({ escalation: "env_broken", step: "network" });
  });

  it("still throws what it does not know", async () => {
    await expect(sweep(new Error("disk full"))).rejects.toThrow("disk full");
  });
});

describe("runSweep and the git identity", () => {
  const policy = async () => ({ checks: [{ name: "lint", run: "x" }], services: {}, wholeSuiteMinutes: 10 });
  const sweep = (identity: { name: string; email: string } | null, exec: Parameters<typeof runSweep>[0]["exec"]) =>
    runSweep({ exec, changedPaths: async () => null, impact: async () => [], policy, gitIdentity: async () => identity }, { worktree: "/w", repoPath: "/r", env: { PATH: "/bin" } });

  it("escalates as env_broken, as Verify does, instead of running the checks as nobody", async () => {
    let ran = false;
    const outcome = await sweep(null, async () => ((ran = true), { code: 0, stdout: "", stderr: "" }));
    expect(ran).toBe(false);
    expect(outcome).toMatchObject({ status: "failed", escalated: { escalation: "env_broken", envBroken: true, step: "checks", reason: expect.stringMatching(/git has no identity.*user\.name.*user\.email/) } });
  });

  it("hands the checks the identity git resolves, on top of the env it was given", async () => {
    let seen: Record<string, string | undefined> = {};
    await sweep({ name: "Ada L", email: "ada@x.dev" }, async (_c, _a, options) => ((seen = (options as { env: Record<string, string | undefined> }).env), { code: 0, stdout: "", stderr: "" }));
    expect(seen).toMatchObject({ PATH: "/bin", GIT_AUTHOR_NAME: "Ada L", GIT_AUTHOR_EMAIL: "ada@x.dev", GIT_COMMITTER_NAME: "Ada L", GIT_COMMITTER_EMAIL: "ada@x.dev" });
  });
});

describe("tailOf: a long check output keeps its failures", () => {
  // DISC-53: turbo's last 60 lines were all `outputs` warnings, and the implementer never saw which test failed.
  const noise = Array.from({ length: 300 }, (_, i) => `WARNING no output files found for task @discover/pkg${i}#test:unit. Please check your \`outputs\` key in \`turbo.json\``);
  const failing = [" FAIL  src/forms/forms.service.test.ts > save > writes the components", "AssertionError: expected 404 to be 200", " ❯ src/forms/forms.service.test.ts:42:17"];
  const text = [...noise.slice(0, 120), ...failing, ...noise.slice(120), "ERROR run failed: command exited (1)"].join("\n");

  it("ends with the failing lines from anywhere in the output, after the last lines", () => {
    const tail = tailOf(text);
    expect(tail).toContain("FAIL  src/forms/forms.service.test.ts > save > writes the components");
    expect(tail).toContain("AssertionError: expected 404 to be 200");
    expect(tail.trimEnd().split("\n").at(-1)).toMatch(/forms\.service\.test\.ts:42:17|AssertionError|FAIL/);
    expect(tail).toContain("ERROR run failed: command exited (1)");
  });

  it("keeps the line before each failing line, where a linter names the file (DISC-53: Biome's `×` lines carry no path)", () => {
    const biome = [...noise.slice(0, 100), "packages/domain/src/Task/index.ts:8:1 assist/source/organizeImports FIXABLE", "  × The imports and exports are not sorted.", ...noise.slice(100)].join("\n");
    const tail = tailOf(biome);
    expect(tail).toContain("packages/domain/src/Task/index.ts:8:1 assist/source/organizeImports FIXABLE\n  × The imports and exports are not sorted.");
  });

  it("finds a failing line the runner coloured, and keeps it without its colour codes (DISC-53: vitest's coloured FAIL never matched)", () => {
    const coloured = [...noise.slice(0, 100), "\u001b[41m\u001b[1mFAIL\u001b[22m\u001b[49m src/forms/forms.service.test.ts > save", ...noise.slice(100)].join("\n");
    const tail = tailOf(coloured);
    expect(tail).toContain("FAIL src/forms/forms.service.test.ts > save");
    expect(tail).not.toContain("\u001b[");
  });

  it("leaves out a passing test's logged errors and keeps the runner's own failure lines (DISC-53: 'Error: db down' logs pushed vitest's FAIL out)", () => {
    const logs = Array.from({ length: 200 }, (_, i) => `@discover/api:test:unit: stderr | src/m${i}.test.ts > logs and recovers\n@discover/api:test:unit: Failed to resolve the PDF password; sealing with a random one Error: db down`);
    const out = [...logs.slice(0, 50), "@discover/api:test:unit:  FAIL  src/forms/forms.service.test.ts > save > writes the components", "@discover/api:test:unit: AssertionError: expected 404 to be 200", ...logs.slice(50), "@discover/api:test:unit:  Test Files  1 failed | 211 passed (212)", ...noise.slice(0, 70)].join("\n");
    const tail = tailOf(out);
    expect(tail).toContain("FAIL  src/forms/forms.service.test.ts > save > writes the components");
    expect(tail).toContain("AssertionError: expected 404 to be 200");
    expect(tail).toContain("Test Files  1 failed");
    expect(tail).not.toContain("Error: db down");
  });

  it("is the last lines as before for a short output, or one with no failing line", () => {
    expect(tailOf("a\nb\nc")).toBe("a\nb\nc");
    const quiet = noise.join("\n");
    expect(tailOf(quiet)).toBe(noise.slice(-60).join("\n"));
  });
});
