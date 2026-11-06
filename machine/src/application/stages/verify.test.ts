import { RepoImageError } from "../repo-images.ts";
import { EgressUnsupportedError } from "../../adapters/docker/egress.ts";
import { InstallFailedError } from "../install.ts";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { TaskRow } from "../../domain/task.ts";
import type { ExecResult } from "../../adapters/process/exec.ts";
import type { StageContext, StageResult } from "../ports.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import type { Decide } from "./check-decide.ts";
import { verifyRunner } from "./verify.ts";

const finding = (over: Record<string, unknown> = {}) => ({
  path: "a.ts",
  line: 3,
  start_line: null,
  severity: "bug",
  title: "off by one",
  body: "b",
  suggestion_code: null,
  confidence: 0.9,
  ...over,
});

function setup(opts: {
  checks?: Record<string, ExecResult>;
  detected?: Record<string, unknown>;
  pack?: StageResult;
  controller?: AbortController;
  noPack?: boolean;
  identity?: { name: string; email: string } | null;
  /** The repo's own checks from luna.yaml; undefined means none declared. */
  lunaChecks?: Array<{ name: string; run: string; cwd?: string; paths?: string[]; coverage?: string }>;
  /** A real directory standing in for the task worktree (default /wt). */
  worktree?: string;
  diffSince?: (worktreePath: string, repoPath: string) => Promise<string | null>;
  changed?: string[] | null;
  services?: Record<string, { image: string; exports?: Record<string, string> }>;
  decide?: Decide | null;
  decisions?: Record<string, Record<string, { proceed?: number; flag?: number }>>;
}) {
  const stateDir = mkdtempSync(join(tmpdir(), "verify-"));
  const calls: string[][] = [];
  const exec = vi.fn(async (command: string, args: string[], _options?: { env?: NodeJS.ProcessEnv; services?: unknown }) => {
    calls.push([command, ...args]);
    return opts.checks?.[[command, ...args].join(" ")] ?? { code: 0, stdout: "ok\n", stderr: "" };
  });
  const runPack = vi.fn(async () => opts.pack ?? { outcome: "pass" as const, detail: { answer: { verdict: "pass", summary: "fine", findings: [] } } });
  const run = verifyRunner({
    exec,
    runPack: opts.noPack ? null : runPack,
    stateDir,
    detect: async () => (opts.detected ?? { manager: "pnpm", test: ["pnpm", "run", "test"], lint: ["pnpm", "run", "lint"] }) as never,
    gitIdentity: async () => ("identity" in opts ? opts.identity! : { name: "Ada L", email: "ada@x.dev" }),
    policy: async () => ({ checks: opts.lunaChecks ?? null, services: opts.services ?? {}, decisions: opts.decisions ?? {} }),
    ...("decide" in opts ? { decide: opts.decide } : {}),
    changedPaths: async () => ("changed" in opts ? opts.changed! : null),
    ...(opts.diffSince ? { diffSince: opts.diffSince } : {}),
  });
  const controller = opts.controller ?? new AbortController();
  const context: StageContext = {
    task: { id: "t1", worktreePath: opts.worktree ?? "/wt", repoPath: "/repo" } as unknown as TaskRow,
    stage: "verifying",
    attempt: 1,
    runId: "run-1",
    approvals: [],
    signal: controller.signal,
  };
  return { run, context, exec, runPack, calls, stateDir };
}

describe("verifying stage", () => {
  it("fails on a red check with its tail as a test finding, and never calls the pack", async () => {
    const tail = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
    const { run, context, runPack, stateDir } = setup({
      checks: { "pnpm run test": { code: 1, stdout: tail, stderr: "" } },
    });
    const result = await run(context);
    expect(result.outcome).toBe("fail");
    expect(runPack).not.toHaveBeenCalled();
    const detail = result.detail as { step: string; failed: Array<{ name: string; tail: string; cmd: string }> };
    expect(detail.step).toBe("checks");
    expect(detail.failed).toHaveLength(1);
    expect(detail.failed[0]).toMatchObject({ name: "test", cmd: "pnpm run test" });
    expect(detail.failed[0]!.tail.split("\n")).toHaveLength(60);
    expect(detail.failed[0]!.tail).toContain("line 99");
    expect(result.findings).toEqual([
      expect.objectContaining({ path: "", line: 0, severity: "test", title: "test failed", confidence: 1, body: detail.failed[0]!.tail }),
    ]);
    expect((result.detail as { findings: unknown[] }).findings).toEqual(result.findings);
    expect(readFileSync(join(stateDir, "runs", "run-1", "checks.log"), "utf8")).toContain("line 99");
  });

  it("escalates, never retrying, when the test command itself is missing from the runner image", async () => {
    // Exit 127 is the shell's "command not found": no implementing attempt can fix the image.
    const { run, context, runPack } = setup({
      checks: { "pnpm run test": { code: 127, stdout: "", stderr: "sh: pnpm: not found\n" } },
    });
    const result = await run(context);
    expect(result.outcome).toBe("escalated");
    expect(result.detail).toMatchObject({ reason: expect.stringMatching(/pnpm run test.*runner image/) });
    expect(runPack).not.toHaveBeenCalled();
  });

  it("runs every check as you: the identity git resolves for the repo rides into the check container", async () => {
    const { run, context, exec } = setup({});
    await run(context);
    const env = exec.mock.calls[0]![2]!.env!;
    expect(env).toMatchObject({ GIT_AUTHOR_NAME: "Ada L", GIT_AUTHOR_EMAIL: "ada@x.dev", GIT_COMMITTER_NAME: "Ada L", GIT_COMMITTER_EMAIL: "ada@x.dev" });
  });

  it("escalates before running anything when the repo has no git identity: a suite that commits would fail as nobody", async () => {
    const { run, context, exec, runPack } = setup({ identity: null });
    const result = await run(context);
    expect(result.outcome).toBe("escalated");
    expect(result.detail).toMatchObject({ step: "checks", reason: expect.stringMatching(/user\.name.*user\.email/) });
    expect(exec).not.toHaveBeenCalled();
    expect(runPack).not.toHaveBeenCalled();
  });

  it("runs the repo's own checks from luna.yaml, each through sh in its cwd, instead of detecting them", async () => {
    const { run, context, calls, runPack } = setup({
      lunaChecks: [
        { name: "board tests", run: "cargo test", cwd: "board" },
        { name: "lint", run: "pnpm lint" },
      ],
    });
    const result = await run(context);
    expect(calls).toEqual([
      ["sh", "-c", "cd 'board' && cargo test"],
      ["sh", "-c", "pnpm lint"],
    ]);
    expect(result.outcome).toBe("pass");
    expect(result.detail).toMatchObject({ checks: [{ name: "board tests", cmd: "cargo test (in board)", ok: true }, { name: "lint", ok: true }] });
    expect(runPack).toHaveBeenCalledOnce();
  });

  it("runs only the checks whose paths the branch touches, and says which were skipped", async () => {
    const { run, context, calls } = setup({
      lunaChecks: [
        { name: "board tests", run: "cargo test", cwd: "board", paths: ["board/**"] },
        { name: "machine tests", run: "pnpm test", cwd: "machine", paths: ["machine/**"] },
      ],
      changed: ["board/src/ui.rs"],
    });
    const result = await run(context);
    expect(calls).toEqual([["sh", "-c", "cd 'board' && cargo test"]]);
    expect(result.detail).toMatchObject({ checks: [{ name: "board tests", ok: true }, { name: "machine tests", skipped: "no change under machine/**" }] });
  });

  describe("the regression sweep", () => {
    const withGraph = (changed: string[] | null) => {
      const graphDir = mkdtempSync(join(tmpdir(), "verify-graph-"));
      mkdirSync(join(graphDir, "graphify-out"));
      writeFileSync(
        join(graphDir, "graphify-out", "graph.json"),
        JSON.stringify({ nodes: [{ id: "A", source_file: "board/src/a.rs" }, { id: "M", source_file: "machine/src/m.ts" }], links: [{ source: "M", target: "A" }] }),
      );
      const stateDir = mkdtempSync(join(tmpdir(), "verify-"));
      const calls: string[][] = [];
      const runPack = vi.fn(async (_context: StageContext, _extra?: { blastRadius?: string[] }) => ({ outcome: "pass" as const, detail: { answer: { verdict: "pass", summary: "fine", findings: [] } } }));
      const run = verifyRunner({
        exec: async (command, args) => (calls.push([command, ...args]), { code: 0, stdout: "", stderr: "" }),
        runPack,
        stateDir,
        gitIdentity: async () => ({ name: "A", email: "a@x.dev" }),
        policy: async () => ({
          checks: [
            { name: "board tests", run: "cargo test", cwd: "board", paths: ["board/**"] },
            { name: "machine tests", run: "pnpm test", cwd: "machine", paths: ["machine/**"] },
          ],
          services: {},
        }),
        changedPaths: async () => changed,
        graph: { currentDir: (repo) => (repo === "/repo" ? graphDir : null) },
      });
      return { run, calls, runPack };
    };
    const context = { task: { id: "t1", worktreePath: "/wt", repoPath: "/repo" }, stage: "verifying", attempt: 1, runId: "run-1", approvals: [], signal: new AbortController().signal } as unknown as StageContext;

    it("widens the check selection with the files that depend on the change, hands them to the reviewer and records them", async () => {
      const { run, calls, runPack } = withGraph(["board/src/a.rs"]);
      const result = await run(context);
      expect(calls.map((c) => c[2])).toEqual(["cd 'board' && cargo test", "cd 'machine' && pnpm test"]);
      expect(runPack).toHaveBeenCalledWith(context, { blastRadius: ["machine/src/m.ts"] });
      expect(result.detail).toMatchObject({ blastRadius: ["machine/src/m.ts"] });
    });

    it("changes nothing when the repo has no graph", async () => {
      const { run, calls, runPack } = withGraph(["board/src/a.rs"]);
      const bare = verifyRunner({ exec: async (c, a) => (calls.push([c, ...a]), { code: 0, stdout: "", stderr: "" }), runPack, stateDir: mkdtempSync(join(tmpdir(), "verify-")), gitIdentity: async () => ({ name: "A", email: "a@x" }), policy: async () => ({ checks: null, services: {} }), detect: async () => ({ manager: "pnpm", test: ["t"] }) as never, changedPaths: async () => ["board/src/a.rs"], graph: { currentDir: () => null } });
      const result = await bare(context);
      expect(result.detail).not.toHaveProperty("blastRadius");
      expect(runPack).toHaveBeenLastCalledWith(context, {});
    });
  });

  describe("coverage of the change's added lines", () => {
    const diff = ["diff --git a/src/a.ts b/src/a.ts", "--- a/src/a.ts", "+++ b/src/a.ts", "@@ -9,1 +10,5 @@", " ctx", "+a", "+b", "+c", "+d", ""].join("\n");
    const worktree = () => {
      const dir = mkdtempSync(join(tmpdir(), "verify-wt-"));
      mkdirSync(join(dir, "coverage"), { recursive: true });
      writeFileSync(join(dir, "coverage", "lcov.info"), ["SF:/work/src/a.ts", "DA:11,1", "DA:12,0", "DA:13,2", "DA:14,1", "end_of_record", ""].join("\n"));
      return dir;
    };
    const lunaChecks = [{ name: "tests", run: "pnpm test", coverage: "coverage/lcov.info" }];

    it("reads the report after a passing check, records it, adds a test finding per file with uncovered lines and hands the summary to the verifier", async () => {
      const { run, context, runPack } = setup({ worktree: worktree(), lunaChecks, diffSince: async () => diff });
      const result = await run(context);
      const summary = { files: [{ path: "src/a.ts", added: 4, covered: 3, uncovered: [12] }], total: { added: 4, covered: 3 }, report: "coverage/lcov.info" };
      expect(result.outcome).toBe("pass");
      expect(result.detail).toMatchObject({ coverage: summary });
      expect(result.findings).toEqual([
        expect.objectContaining({ path: "src/a.ts", line: 12, severity: "test", title: "coverage: 3 of 4 added lines in src/a.ts are not covered", body: "uncovered: 12", confidence: 0.9 }),
      ]);
      expect(runPack).toHaveBeenCalledWith(context, { coverage: summary });
    });

    it("notes a report that is missing and still passes", async () => {
      const { run, context } = setup({ worktree: mkdtempSync(join(tmpdir(), "verify-wt-")), lunaChecks, diffSince: async () => diff });
      const result = await run(context);
      expect(result.outcome).toBe("pass");
      expect((result.detail as { checks: unknown[] }).checks).toContainEqual({ name: "tests", note: "coverage report coverage/lcov.info not found" });
      expect(result.detail).not.toHaveProperty("coverage");
    });

    it("treats a report path that is a directory as not found", async () => {
      const wt = worktree();
      mkdirSync(join(wt, "coverage", "dir.info"), { recursive: true });
      const { run, context } = setup({ worktree: wt, lunaChecks: [{ name: "tests", run: "pnpm test", coverage: "coverage/dir.info" }], diffSince: async () => diff });
      const result = await run(context);
      expect(result.outcome).toBe("pass");
      expect(result.detail).not.toHaveProperty("coverage");
      expect(JSON.stringify(result.detail?.checks)).toContain("coverage report coverage/dir.info not found");
    });

    it("does not read a report path that climbs out of the worktree", async () => {
      const { run, context } = setup({ worktree: worktree(), lunaChecks: [{ name: "tests", run: "pnpm test", coverage: "../../etc/passwd" }], diffSince: async () => diff });
      const result = await run(context);
      expect(result.outcome).toBe("pass");
      expect(result.detail).not.toHaveProperty("coverage");
    });

    it("reads no report when the check failed", async () => {
      const { run, context, runPack } = setup({ worktree: worktree(), lunaChecks, diffSince: async () => diff, checks: { "sh -c pnpm test": { code: 1, stdout: "x", stderr: "" } } });
      const result = await run(context);
      expect(runPack).not.toHaveBeenCalled();
      expect(result.detail).not.toHaveProperty("coverage");
    });
  });

  describe("finding_classify after the review", () => {
    const worktree = () => {
      const dir = mkdtempSync(join(tmpdir(), "verify-wt-"));
      mkdirSync(join(dir, "src"), { recursive: true });
      writeFileSync(join(dir, "src", "a.ts"), Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n"));
      writeFileSync(join(dir, "..", `${dir.split("/").pop()}-secret.txt`), "outside");
      return dir;
    };
    const review = (findings: unknown[]): StageResult => ({ outcome: "pass", detail: { answer: { verdict: "pass", summary: "fine", findings } } });
    const choose = (choice: string) => ({ severity: { choice, confidence: 0.9 } });

    it("classifies each finding with an excerpt, records the rows and the calibration, and leaves the outcome alone", async () => {
      const findings = [finding({ path: "src/a.ts", line: 10, severity: "bug", title: "first", confidence: 0.9 }), finding({ path: "src/a.ts", line: 20, severity: "nit", title: "second", confidence: 0.6 })];
      const decide = vi.fn<Decide>(async (_pack, check) => choose(check.finding?.title === "first" ? "blocker" : "should_fix"));
      const base = setup({ worktree: worktree(), pack: review(findings) });
      const { run, context } = setup({ worktree: worktree(), pack: review(findings), decide });
      const result = await run(context);
      expect(result.outcome).toBe((await base.run(base.context)).outcome);
      expect(decide).toHaveBeenCalledTimes(2);
      const first = decide.mock.calls.find(([, c]) => c.finding?.title === "first")!;
      expect(first[0]).toBe("finding_classify");
      expect(first[1].kind).toBe("finding");
      expect(first[1].excerpt).toContain("line 10");
      expect(first[1].excerpt).toContain("line 2\n");
      expect(first[1].excerpt).not.toContain("line 19");
      const detail = result.detail as { classified: Array<Record<string, unknown>>; calibration: unknown };
      expect(detail.classified).toEqual([
        { title: "first", path: "src/a.ts", line: 10, severity: "bug", classified: "blocker", confidence: 0.9, verdict: "proceed" },
        { title: "second", path: "src/a.ts", line: 20, severity: "nit", classified: "should_fix", confidence: 0.9, verdict: "proceed" },
      ]);
      expect(detail.calibration).toEqual({ agree: 1, disagree: 1, skipped: 0 });
    });

    it("classifies at most the six most confident findings", async () => {
      const findings = Array.from({ length: 7 }, (_, i) => finding({ path: "src/a.ts", line: i + 1, title: `f${i}`, severity: "nit", confidence: 0.5 + i / 20 }));
      const decide = vi.fn<Decide>(async () => choose("nit"));
      const { run, context } = setup({ worktree: worktree(), pack: review(findings), decide });
      const result = await run(context);
      expect(decide).toHaveBeenCalledTimes(6);
      const titles = (result.detail as { classified: Array<{ title: string }> }).classified.map((c) => c.title);
      expect(titles).not.toContain("f0");
    });

    it("keeps the excerpt inside the worktree: a path that climbs out gets none", async () => {
      const wt = worktree();
      const decide = vi.fn<Decide>(async () => choose("nit"));
      const { run, context } = setup({ worktree: wt, pack: review([finding({ path: `../${wt.split("/").pop()}-secret.txt`, line: 1 })]), decide });
      await run(context);
      expect(decide.mock.calls[0]![1].excerpt ?? "").toBe("");
    });

    it("reads no excerpt from a directory or from a file over the size cap: only regular files of a sane size", async () => {
      const wt = worktree();
      writeFileSync(join(wt, "src", "big.ts"), "x".repeat(1_100_000));
      const decide = vi.fn<Decide>(async () => choose("nit"));
      const { run, context } = setup({ worktree: wt, pack: review([finding({ path: "src", line: 1, title: "dir" }), finding({ path: "src/big.ts", line: 1, title: "big" })]), decide });
      await run(context);
      for (const [, check] of decide.mock.calls) expect(check.excerpt ?? "").toBe("");
    });

    it("records nothing without a decide, and a skipped decision counts as skipped", async () => {
      const findings = [finding({ path: "src/a.ts", line: 3, severity: "nit" })];
      const none = setup({ worktree: worktree(), pack: review(findings), decide: null });
      expect((await none.run(none.context)).detail).not.toHaveProperty("classified");
      const failing = setup({ worktree: worktree(), pack: review(findings), decide: async () => { throw new Error("no jev"); } });
      const detail = (await failing.run(failing.context)).detail as { classified: Array<{ classified: unknown; verdict: string }>; calibration: unknown };
      expect(detail.classified[0]).toMatchObject({ classified: null, confidence: null, verdict: "skipped" });
      expect(detail.calibration).toEqual({ agree: 0, disagree: 0, skipped: 1 });
    });

    it("never changes the verdict, whatever the classification says", async () => {
      const findings = [finding({ path: "src/a.ts", line: 3, severity: "bug", confidence: 0.95 })];
      const failing: StageResult = { outcome: "pass", detail: { answer: { verdict: "fail", summary: "bad", findings } } };
      const a = setup({ worktree: worktree(), pack: failing, decide: async () => choose("nit") });
      const b = setup({ worktree: worktree(), pack: failing });
      expect((await a.run(a.context)).outcome).toBe("fail");
      expect((await b.run(b.context)).outcome).toBe("fail");
    });
  });

  it("names a failed luna.yaml check by its own name, with its tail, so the finding reads like the file", async () => {
    const { run, context, runPack } = setup({
      lunaChecks: [{ name: "board tests", run: "cargo test", cwd: "board" }],
      checks: { "sh -c cd 'board' && cargo test": { code: 101, stdout: "test x ... FAILED", stderr: "" } },
    });
    const result = await run(context);
    expect(result.outcome).toBe("fail");
    expect(result.detail).toMatchObject({ summary: "board tests failed", error: expect.stringContaining("cargo test (in board)") });
    expect(result.findings).toEqual([expect.objectContaining({ severity: "test", title: "board tests failed", body: "test x ... FAILED" })]);
    expect(runPack).not.toHaveBeenCalled();
  });

  it("asks for the repo's services beside every check, so a suite that needs a database gets one", async () => {
    const services = { postgres: { image: "postgres:16", exports: { DATABASE_URL: "postgres://app@postgres:5432/app" } } };
    const { run, context, exec } = setup({ services });
    await run(context);
    expect(exec.mock.calls[0]![2]).toMatchObject({ services });
  });

  it("runs the review pack when checks pass and fails on its fail verdict", async () => {
    const f = finding();
    const { run, context, runPack } = setup({
      pack: { outcome: "pass", detail: { answer: { verdict: "fail", summary: "bug", findings: [f] } }, findings: [] },
    });
    const result = await run(context);
    expect(runPack).toHaveBeenCalledOnce();
    expect(result.outcome).toBe("fail");
    expect(result.findings).toEqual([f]);
    expect(result.detail).toMatchObject({ step: "review", verdict: "fail", summary: "bug", findings: [f] });
    expect((result.detail as { checks: Array<{ name: string }> }).checks.map((c) => c.name)).toEqual(["test", "lint"]);
  });

  it("passes when checks and the review pass", async () => {
    const { run, context } = setup({});
    const result = await run(context);
    expect(result.outcome).toBe("pass");
    expect(result.detail).toMatchObject({ step: "review", verdict: "pass", summary: "fine" });
  });

  it("computes the verdict mechanically when the answer has none", async () => {
    const low = finding({ confidence: 0.5 });
    const nit = finding({ severity: "nit" });
    const mk = (findings: unknown[]) => ({ outcome: "pass" as const, detail: { answer: { findings } }, findings: [] });
    expect((await setup({ pack: mk([low, nit]) }).run(setup({}).context)).outcome).toBe("pass");
    const s = setup({ pack: mk([finding({ severity: "security" })]) });
    expect((await s.run(s.context)).outcome).toBe("fail");
  });

  it("falls back to the result findings when the answer has none", async () => {
    const f = finding();
    const s = setup({ pack: { outcome: "pass", detail: {}, findings: [f] } });
    const result = await s.run(s.context);
    expect(result.outcome).toBe("fail");
    expect(result.findings).toEqual([f]);
  });

  it("skips the checks with a note when no test command is detected, and still runs the pack", async () => {
    const { run, context, runPack, exec } = setup({ detected: { manager: null } });
    const result = await run(context);
    expect(exec).not.toHaveBeenCalled();
    expect(runPack).toHaveBeenCalledTimes(1);
    expect(result.outcome).toBe("pass");
    expect(String(result.detail?.note)).toContain("no test command");
  });

  it("runs lint when only lint is detected, skips the test check, and runs the pack", async () => {
    const { run, context, runPack, calls } = setup({ detected: { manager: "pnpm", lint: ["pnpm", "run", "lint"] } });
    const result = await run(context);
    expect(calls).toEqual([["pnpm", "run", "lint"]]);
    expect(runPack).toHaveBeenCalledTimes(1);
    expect(result.outcome).toBe("pass");
  });

  it("still fails on a red lint even when there is no test command", async () => {
    const { run, context, runPack } = setup({
      detected: { manager: "pnpm", lint: ["pnpm", "run", "lint"] },
      checks: { "pnpm run lint": { code: 1, stdout: "", stderr: "eslint: 3 errors" } },
    });
    const result = await run(context);
    expect(runPack).not.toHaveBeenCalled();
    expect(result.outcome).toBe("fail");
  });

  it("passes without running anything when the task has no worktree", async () => {
    const { run, context, exec, runPack } = setup({});
    context.task = { id: "t1", worktreePath: null, repoPath: "/repo" } as unknown as TaskRow;
    const result = await run(context);
    expect(result.outcome).toBe("pass");
    expect(result.detail).toMatchObject({ note: "no worktree; implementer was stubbed" });
    expect(exec).not.toHaveBeenCalled();
    expect(runPack).not.toHaveBeenCalled();
  });

  it("sets HARDNESS_STAGE=verifying and a 30 minute budget on every check", async () => {
    const { run, context, exec } = setup({});
    await run(context);
    expect(exec).toHaveBeenCalledTimes(2);
    for (const call of exec.mock.calls) {
      const options = (call as unknown as [string, string[], { env?: NodeJS.ProcessEnv; timeoutMs?: number; signal?: AbortSignal }])[2];
      expect(options.env?.HARDNESS_STAGE).toBe("verifying");
      expect(options.signal).toBeDefined();
      expect(options.timeoutMs).toBeGreaterThan(29 * 60_000);
      expect(options.timeoutMs).toBeLessThanOrEqual(30 * 60_000);
    }
  });

  it("skips the review with a note when agents are off (runPack null)", async () => {
    const s = setup({ noPack: true });
    const result = await s.run(s.context);
    expect(s.exec).toHaveBeenCalledTimes(2);
    expect(result.outcome).toBe("pass");
    expect(result.detail).toMatchObject({ step: "checks", note: "review: skipped (agents off)" });
  });

  it("adds an error line with the failing command and its output to a red check", async () => {
    const { run, context } = setup({ checks: { "pnpm run test": { code: 1, stdout: "boom", stderr: "" } } });
    const result = await run(context);
    expect((result.detail as { error: string }).error).toBe("`pnpm run test` failed:\nboom");
  });

  it("treats a pack that asks questions as a pass with a note", async () => {
    const s = setup({ pack: { outcome: "needs_input", detail: { questions: [{ q: "?" }] } } });
    const result = await s.run(s.context);
    expect(result.outcome).toBe("pass");
    expect(result.detail).toMatchObject({ verdict: "pass", note: expect.stringContaining("question") });
  });

  it("fails on a failing result even with zero findings", async () => {
    const results = [{ title: "t", criterion: "c", approach: "a", outcome: "fail" }];
    const { run, context } = setup({
      pack: { outcome: "pass", detail: { answer: { verdict: "pass", summary: "fine", findings: [], results } } },
    });
    const { outcome, detail } = await run(context);
    expect(outcome).toBe("fail");
    expect(detail?.results).toEqual(results);
  });

  it("passes with passing results and no findings", async () => {
    const results = [{ title: "t", criterion: "c", approach: "a", outcome: "pass" }];
    const { run, context } = setup({
      pack: { outcome: "pass", detail: { answer: { verdict: "pass", summary: "fine", findings: [], results } } },
    });
    const { outcome, detail } = await run(context);
    expect(outcome).toBe("pass");
    expect(detail?.results).toEqual(results);
  });

  it("lists one verdict per case from the pack's results, and none when the pack gave no results", async () => {
    const results = [
      { title: "shows an error", criterion: "c", approach: "a", outcome: "pass" },
      { title: "locks after three", criterion: "c", approach: "a", outcome: "fail" },
    ];
    const withResults = setup({ pack: { outcome: "pass", detail: { answer: { verdict: "pass", summary: "fine", findings: [], results } } } });
    expect((await withResults.run(withResults.context)).detail?.cases).toEqual([
      { title: "shows an error", ok: true },
      { title: "locks after three", ok: false },
    ]);
    const without = setup({ pack: { outcome: "pass", detail: { answer: { verdict: "pass", summary: "fine", findings: [] } } } });
    expect((await without.run(without.context)).detail).not.toHaveProperty("cases");
  });

  it("passes through an escalated pack unchanged, never computing a verdict over it", async () => {
    const escalated: StageResult = { outcome: "escalated", detail: { reason: "a pre-existing failure", options: [] } };
    const { run, context } = setup({ pack: escalated });
    const { outcome, detail } = await run(context);
    expect(outcome).toBe("escalated");
    expect(detail).toMatchObject({ reason: "a pre-existing failure", step: "review" });
  });

  it("returns the pack's own failure with the checks attached", async () => {
    const s = setup({ pack: { outcome: "fail", detail: { error: "timed out" } } });
    const result = await s.run(s.context);
    expect(result.outcome).toBe("fail");
    expect(result.detail).toMatchObject({ error: "timed out", step: "review" });
  });

  it("fails as aborted when the signal fires", async () => {
    const controller = new AbortController();
    const s = setup({ controller });
    s.exec.mockImplementationOnce(async () => {
      controller.abort();
      return { code: 1, stdout: "", stderr: "" };
    });
    const result = await s.run(s.context);
    expect(result.outcome).toBe("fail");
    expect(result.detail).toMatchObject({ error: "aborted" });
    expect(s.runPack).not.toHaveBeenCalled();
  });
});

describe("verify on a fresh clone", () => {
  const card = { id: "t1", branch: "task/x", worktreePath: "/card", repoPath: "/repo" };
  const build = (outcome: "pass" | "fail" | "escalated", broughtBack: { ok: boolean; reason?: string } = { ok: true }) => {
    const seen = { cwd: [] as (string | undefined)[], packPath: "", removed: [] as string[], kept: [] as string[][], back: [] as string[][], made: [] as string[][] };
    const runner = verifyRunner({
      exec: async (_c, _a, options) => (seen.cwd.push(options.cwd), { code: 0, stdout: "", stderr: "" }),
      runPack: async (context) => {
        seen.packPath = context.task.worktreePath!;
        return { outcome, detail: outcome === "pass" ? { answer: { verdict: "pass", findings: [], results: [], summary: "ok" } } : { reason: "r" }, workspace: { branch: "task/x", worktreePath: context.task.worktreePath! } } as StageResult;
      },
      stateDir: "/tmp/state",
      detect: async () => ({ test: ["pnpm", "test"] }) as never,
      gitIdentity: async () => ({ name: "a", email: "a@b" }),
      changedPaths: async () => null,
      fresh: {
        make: async (path, branch, runId) => (seen.made.push([path, branch, runId]), { path: "/card.verify", commit: "a".repeat(40) }),
        bringBack: async (path, freshPath, branch, from) => (seen.back.push([path, freshPath, branch, from]), broughtBack),
        remove: async (path) => void seen.removed.push(path),
        keep: async (path, taskId, runId) => void seen.kept.push([path, taskId, runId]),
      },
    });
    const context = { task: card, stage: "verifying", attempt: 1, runId: "run-1", approvals: [], signal: new AbortController().signal } as unknown as StageContext;
    return { runner, context, seen };
  };

  it("runs the checks and the review in the fresh clone, never in the card's folder, and names the commit it was made at", async () => {
    const { runner, context, seen } = build("pass");
    const result = await runner(context);
    expect(seen.made).toEqual([["/card", "task/x", "run-1"]]);
    expect(seen.cwd).toEqual(["/card.verify"]);
    expect(seen.packPath).toBe("/card.verify");
    expect(result.detail).toMatchObject({ freshClone: { commit: "a".repeat(40) } });
    // The fresh folder is never the task's workspace.
    expect(result.workspace).toBeUndefined();
  });

  it("brings the commits back after a pass, and removes the folder", async () => {
    const { runner, context, seen } = build("pass");
    expect((await runner(context)).outcome).toBe("pass");
    expect(seen.back).toEqual([["/card", "/card.verify", "task/x", "a".repeat(40)]]);
    expect(seen.removed).toEqual(["/card.verify"]);
  });

  it("fails the stage when what Verify left cannot come back as a fast-forward", async () => {
    const { runner, context } = build("pass", { ok: false, reason: "not a fast-forward" });
    const result = await runner(context);
    expect(result.outcome).toBe("fail");
    expect(JSON.stringify(result.detail)).toContain("not a fast-forward");
  });

  it("brings nothing back after a failure, and keeps the folder on an escalation", async () => {
    const failed = build("fail");
    await failed.runner(failed.context);
    expect(failed.seen.back).toEqual([]);
    expect(failed.seen.removed).toEqual(["/card.verify"]);
    const escalated = build("escalated");
    await escalated.runner(escalated.context);
    expect(escalated.seen.back).toEqual([]);
    expect(escalated.seen.removed).toEqual([]);
    // Kept folders are registered, so the keep ends after sandbox.keep_hours.
    expect(escalated.seen.kept).toEqual([["/card.verify", "t1", "run-1"]]);
    expect(failed.seen.kept).toEqual([]);
  });

  describe("the environment comparison", () => {
    const recorded = { hash: "h", image: "sha256:build", commit: "a".repeat(40), lockfiles: { "Cargo.lock": "h2" } };
    const runnerFor = (current: { image: string; lockfiles: Record<string, string> }, built: typeof recorded | null = recorded) => {
      const pack = vi.fn(async () => ({ outcome: "pass", detail: { answer: { verdict: "pass", findings: [], results: [], summary: "ok" } } }) as StageResult);
      const runner = verifyRunner({
        exec: async () => ({ code: 0, stdout: "", stderr: "" }),
        runPack: pack,
        stateDir: "/tmp/state",
        detect: async () => ({ test: ["t"] }) as never,
        gitIdentity: async () => ({ name: "a", email: "a@b" }),
        changedPaths: async () => null,
        fresh: { make: async () => ({ path: "/card.verify", commit: recorded.commit }), bringBack: async () => ({ ok: true }), remove: async () => {} },
        buildEnv: async () => built,
        envOf: async (_path, commit) => ({ ...current, commit, hash: "x" }),
      });
      const context = { task: { id: "t1", branch: "task/x", worktreePath: "/card", repoPath: "/repo" }, stage: "verifying", attempt: 1, runId: "run-1", approvals: [], signal: new AbortController().signal } as unknown as StageContext;
      return { runner, context, pack };
    };

    it("says matched when the image and the lockfiles are the ones Build recorded", async () => {
      const { runner, context } = runnerFor({ image: "sha256:build", lockfiles: { "Cargo.lock": "h2" } });
      const result = await runner(context);
      expect(result.outcome).toBe("pass");
      expect(result.detail).toMatchObject({ envReproduction: "matched" });
    });

    it("fails with a blocker finding, category env, naming both images, before the review runs", async () => {
      const { runner, context, pack } = runnerFor({ image: "sha256:other", lockfiles: { "Cargo.lock": "h2" } });
      const result = await runner(context);
      expect(result.outcome).toBe("fail");
      expect(pack).not.toHaveBeenCalled();
      expect(result.findings).toMatchObject([{ severity: "blocker", category: "env", body: expect.stringContaining("sha256:build") }]);
      expect(result.findings![0]!.body).toContain("sha256:other");
      expect(result.detail).toMatchObject({ envReproduction: expect.stringContaining("the runner image differs") });
    });

    it("fails on a lockfile that differs at the same commit", async () => {
      const { runner, context } = runnerFor({ image: "sha256:build", lockfiles: { "Cargo.lock": "h9" } });
      expect(await runner(context)).toMatchObject({ outcome: "fail", findings: [{ category: "env" }] });
    });

    it("compares nothing when Build recorded nothing", async () => {
      const { runner, context } = runnerFor({ image: "sha256:other", lockfiles: {} }, null);
      const result = await runner(context);
      expect(result.outcome).toBe("pass");
      expect(result.detail).not.toHaveProperty("envReproduction");
    });
  });
});

describe("with no sandbox to run the repository's checks in", () => {
  it("runs nothing on the host and escalates as an environment problem", async () => {
    const pack = vi.fn();
    const runner = verifyRunner({ exec: null, runPack: pack, stateDir: "/tmp/state", detect: async () => ({ test: ["t"] }) as never, gitIdentity: async () => ({ name: "a", email: "a@b" }), changedPaths: async () => null });
    const context = { task: { id: "t1", branch: "task/x", worktreePath: "/card", repoPath: "/repo" }, stage: "verifying", attempt: 1, runId: "run-1", approvals: [], signal: new AbortController().signal } as unknown as StageContext;
    const result = await runner(context);
    expect(result).toMatchObject({ outcome: "escalated", detail: { escalation: "env_broken", reason: expect.stringContaining("never run on the host") } });
    expect(pack).not.toHaveBeenCalled();
  });
});

describe("when the repository's image cannot be built while a check runs", () => {
  it("escalates as an environment problem with the reason, not as an exception", async () => {
    const exec = async () => { throw new RepoImageError("step 3 failed: no such package"); };
    const runner = verifyRunner({ exec: exec as never, runPack: vi.fn(), stateDir: "/tmp/state", detect: async () => ({ test: ["t"] }) as never, gitIdentity: async () => ({ name: "a", email: "a@b" }), changedPaths: async () => null });
    const context = { task: { id: "t1", branch: "task/x", worktreePath: "/card", repoPath: "/repo" }, stage: "verifying", attempt: 1, runId: "run-1", approvals: [], signal: new AbortController().signal } as unknown as StageContext;
    expect(await runner(context)).toMatchObject({ outcome: "escalated", detail: { escalation: "env_broken", envBroken: true, reason: expect.stringContaining("no such package") } });
  });
});

describe("the network a check runs on", () => {
  const base = { runPack: vi.fn(), stateDir: mkdtempSync(join(tmpdir(), "verify-net-")), detect: async () => ({ test: ["t"] }) as never, gitIdentity: async () => ({ name: "a", email: "a@b" }), changedPaths: async () => null };
  const ctx = (emit?: StageContext["emit"]) => ({ task: { id: "t1", branch: "task/x", worktreePath: "/card", repoPath: "/repo" }, stage: "verifying", attempt: 1, runId: "run-1", approvals: [], signal: new AbortController().signal, ...(emit ? { emit } : {}) }) as unknown as StageContext;

  it("escalates as env_broken at step network when the daemon cannot make the isolated one", async () => {
    const runner = verifyRunner({ ...base, exec: (async () => { throw new EgressUnsupportedError("old daemon"); }) as never });
    expect(await runner(ctx())).toMatchObject({ outcome: "escalated", detail: { escalation: "env_broken", envBroken: true, step: "network", reason: expect.stringContaining("Docker Engine 28") } });
  });

  it("emits what a check's container was refused, as a check row", async () => {
    const rows = [{ host: "evil.example.com", port: 443, via: "connect", reason: "not_listed", count: 1 }];
    const emitted: Array<[string, Record<string, unknown>]> = [];
    const runner = verifyRunner({ ...base, exec: (async () => ({ code: 0, stdout: "ok", stderr: "", blocked: rows })) as never });
    await runner(ctx(async (kind, payload) => void emitted.push([kind, payload]))).catch(() => {}); // the stubbed review pack answers nothing; the rows were emitted before
    expect(emitted).toContainEqual(["sandbox.egress_blocked", { step: "check", host: "evil.example.com", port: 443, via: "connect", reason: "not_listed", count: 1 }]);
  });
});

describe("when the install before a check fails", () => {
  it("escalates as env_broken at step install with the step's own detail", async () => {
    const detail = { escalation: "env_broken", envBroken: true, step: "install", tool: "npm", lockfile: "package-lock.json", reason: "x", logTail: "boom", options: [] };
    const exec = async () => { throw new InstallFailedError(detail); };
    const runner = verifyRunner({ exec: exec as never, runPack: vi.fn(), stateDir: "/tmp/state", detect: async () => ({ test: ["t"] }) as never, gitIdentity: async () => ({ name: "a", email: "a@b" }), changedPaths: async () => null });
    const context = { task: { id: "t1", branch: "task/x", worktreePath: "/card", repoPath: "/repo" }, stage: "verifying", attempt: 1, runId: "run-1", approvals: [], signal: new AbortController().signal } as unknown as StageContext;
    expect(await runner(context)).toMatchObject({ outcome: "escalated", detail });
  });
});
