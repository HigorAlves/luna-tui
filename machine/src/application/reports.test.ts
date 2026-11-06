import { BuildReport, VerifyReport, findingId } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import type { EventRow, StageRunRow, TaskRow } from "../domain/task.ts";
import { buildProgressOf, buildReportOf, prFactsOf, verifyReportOf } from "./reports.ts";

const task = { branch: "luna/x", diffAdded: 12, diffRemoved: 3, testsPassed: 4, testsTotal: 5 } as unknown as TaskRow;

let n = 0;
const run = (stage: string, attempt: number, extra: Partial<StageRunRow> = {}): StageRunRow =>
  ({ id: `r${++n}`, taskId: "t", stage, attempt, status: "passed", outcome: "pass", engine: "claude:sonnet", inputCommit: null, outputCommit: null, startedAt: new Date("2026-11-01T10:00:00Z"), endedAt: new Date("2026-11-01T10:01:30Z"), ...extra }) as StageRunRow;
const event = (kind: string, payload: Record<string, unknown>): EventRow => ({ id: String(++n), taskId: "t", stageRunId: null, kind, payload, at: new Date("2026-11-01T10:00:00Z") });
const finished = (stage: string, attempt: number, status: string, detail: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => event("stage.finished", { stage, attempt, status, outcome: status === "passed" ? "pass" : "fail", detail, ...extra });

const finding = (title: string, line: number) => ({ path: "src/a.ts", line, severity: "bug", title, body: "b", confidence: 0.8 });

describe("buildReportOf", () => {
  it("assembles the build from the implementing runs and the passing finish's scope facts", () => {
    const runs = [run("implementing", 1, { status: "failed", outcome: "fail" }), run("implementing", 2, { outputCommit: "abc123" }), run("triage", 1)];
    const events = [
      finished("implementing", 1, "failed"),
      finished("implementing", 2, "passed", {
        scope: { facts: { changed: ["src/a.ts", "src/b.ts"], undeclared: [], removedTests: [] } },
        answer: { outOfMap: [{ path: "src/b.ts", reason: "shared type" }, { bad: true }] },
      }),
    ];
    const report = buildReportOf(task, runs, events);
    expect(report).toEqual({
      branch: "luna/x",
      base: null,
      headSha: "abc123",
      envHash: null,
      diffSummary: { added: 12, removed: 3, files: ["src/a.ts", "src/b.ts"] },
      declaredFiles: [{ path: "src/b.ts", reason: "shared type" }],
      tests: [],
      // two runs of 90 s each
      runs: [
        { attempt: 1, outcome: "fail", engine: "claude:sonnet", durationMs: 90_000 },
        { attempt: 2, outcome: "pass", engine: "claude:sonnet", durationMs: 90_000 },
      ],
      tokens: null,
      // 180 s = 3 minutes
      minutes: 3,
      scopeCheck: { clean: true, issues: [] },
      version: 2,
      iterations: [],
      summary: null,
      limits: null,
      testsStep: null,
      sweep: null,
    });
    expect(BuildReport.safeParse(report).success).toBe(true);
  });

  it("fills what wave 8 left empty: the base, the tokens of every run, the iteration log, each scenario's test before and after, the Diff Summary, the severities and the budget's limits", () => {
    const limits = { max_iterations: 15, max_tokens: 2_000_000, max_minutes: 90, backoff_minutes: [1, 30] as [number, number], regression_full_suite_minutes: 10 };
    const summary = { what: "w", why: "y", files: [{ path: "src/a.ts", reason: null, in_code_map: true }], flags_added: [], migrations: [], risks_noticed: [], deps_added: [], todos: [] };
    const events = [
      event("scenario.red", { scenario: "S1" }),
      event("scenario.red", { scenario: "S2" }),
      event("stage.slice.red", { id: 1, title: "s", commit: null }),
      event("stage.slice.green", { id: 1, title: "s", commit: null }),
      event("stage.slice.committed", { id: 1, title: "s", commit: "abc123" }),
      event("build.sweep_failed", { checks: ["lint"] }),
      event("scenario.green", { scenario: "S1" }),
      finished("implementing", 1, "failed", {}, { tokens: { input: 1000, output: 200 } }),
      finished("implementing", 2, "passed", {
        base: "main",
        diffSummary: summary,
        sweep: { status: "passed", ran: ["lint"] },
        testsStep: { status: "committed", commit: "def456", scenarioTests: [{ scenario: "S1", file: "web/cart.test.ts" }, { scenario: "S2", file: "web/cart.test.ts" }] },
        scope: { facts: { changed: ["src/a.ts"] }, issues: [{ severity: "should_fix", kind: "new_dependency", text: "dependency the plan did not name: left-pad" }, { severity: "nit", kind: "todo", text: "TODO left in place: a.ts" }] },
      }, { tokens: { input: 500, output: 50 } }),
    ];
    const report = buildReportOf(task, [run("implementing", 1), run("implementing", 2)], events, limits)!;
    expect(report).toMatchObject({
      base: "main",
      tokens: 1750,
      // A slice's commit lands on its green: the committed row fills the sha, it is not a third iteration.
      iterations: [{ kind: "red", ref: "slice 1", sha: null }, { kind: "green", ref: "slice 1", sha: "abc123" }, { kind: "sweep", ref: "lint", sha: null }],
      tests: [{ scenario: "S1", file: "web/cart.test.ts", before: "fail", after: "pass" }, { scenario: "S2", file: "web/cart.test.ts", before: "fail", after: null }],
      summary,
      limits: { max_iterations: 15, max_tokens: 2_000_000, max_minutes: 90 },
      testsStep: { status: "committed" },
      sweep: { status: "passed", ran: ["lint"] },
      scopeCheck: { clean: false, severities: [{ severity: "should_fix" }, { severity: "nit" }] },
    });
    expect(report.scopeCheck.issues).toEqual(["dependency the plan did not name: left-pad", "TODO left in place: a.ts"]);
    expect(BuildReport.safeParse(report).success).toBe(true);
  });

  it("puts the changed paths through safe() and a cap, and ignores token counts that are not non-negative integers", () => {
    const token = ["ghp", "e".repeat(36)].join("_");
    const many = Array.from({ length: 260 }, (_, i) => `src/f${i}.ts`);
    const events = [
      finished("implementing", 1, "failed", {}, { tokens: { input: -5_000_000, output: 10 } }),
      finished("implementing", 2, "failed", {}, { tokens: { input: 1.5, output: 3 } }),
      finished("implementing", 3, "passed", { scope: { facts: { changed: [`src/${token}.ts`, "a\nb.ts", "x".repeat(500), ...many] } } }, { tokens: { input: 100, output: 20 } }),
    ];
    const report = buildReportOf(task, [run("implementing", 1)], events)!;
    expect(report.tokens).toBe(120);
    expect(JSON.stringify(report.diffSummary.files)).not.toContain(token);
    expect(report.diffSummary.files.every((f) => f.length <= 300 && !f.includes("\n"))).toBe(true);
    expect(report.diffSummary.files.length).toBeLessThanOrEqual(200);
    expect(buildReportOf(task, [run("implementing", 1)], [finished("implementing", 1, "passed", {}, { tokens: { input: -1, output: 1 } })])!.tokens).toBeNull();
  });

  it("reports a card built with the tests step skipped: no tests, and the step says why", () => {
    const events = [finished("implementing", 1, "passed", { testsStep: { status: "skipped", why: "holdout_cases" } })];
    expect(buildReportOf(task, [run("implementing", 1)], events)).toMatchObject({ tests: [], testsStep: { status: "skipped", why: "holdout_cases" } });
  });

  it("names the scope issues and reads a build with no scope facts as clean", () => {
    const events = [finished("implementing", 1, "passed", { scope: { facts: { changed: ["x"], undeclared: ["x"], removedTests: ["t.test.ts"] } } })];
    expect(buildReportOf(task, [run("implementing", 1)], events)?.scopeCheck).toEqual({ clean: false, issues: ["not in the plan and not declared: x", "test removed: t.test.ts"] });
    expect(buildReportOf(task, [run("implementing", 1)], [finished("implementing", 1, "passed")])?.scopeCheck).toEqual({ clean: true, issues: [] });
  });

  it("is null while no implementing run has passed", () => {
    expect(buildReportOf(task, [run("implementing", 1, { status: "failed" })], [])).toBeNull();
    expect(buildReportOf(task, [], [])).toBeNull();
  });
});

describe("verifyReportOf", () => {
  const coverage = { files: [], total: { added: 10, covered: 9 }, report: "lcov.info" };

  it("assembles the verify from the last verifying finish, the PR and the e2e finish", () => {
    const runs = [run("verifying", 1, { outputCommit: "v1sha" }), run("ci_watch", 1)];
    const events = [
      finished("delivering", 1, "passed", { prNumber: 7 }),
      finished("verifying", 1, "passed", { findings: [finding("Null deref", 4)], coverage, results: [{ outcome: "pass" }] }),
      finished("e2e", 1, "passed", { verdict: "pass", criteria: [{ text: "s1", result: "pass" }, { nope: 1 }] }),
    ];
    const report = verifyReportOf(task, runs, events);
    expect(report).toMatchObject({
      prNumber: 7,
      headSha: "v1sha",
      tests: { passed: 4, total: 5 },
      coverageDelta: coverage,
      e2e: { verdict: "pass", scenarios: [{ text: "s1", result: "pass" }], artifacts: [] },
      envReproduction: null,
      overrides: [],
      version: 2,
    });
    expect(report?.findings).toHaveLength(1);
    expect(report?.findings[0]).toMatchObject({ title: "Null deref", id: findingId(finding("Null deref", 4)) });
    expect(report?.findings[0]?.resolution).toBeUndefined();
    expect(VerifyReport.safeParse(report).success).toBe(true);
  });

  it("is complete: who reviewed, the mutation score, the browser run by scenario, the CI class and the rounds used; a report from before still validates", () => {
    const runs = [run("verifying", 1, { engine: "codex:sol" }), run("ci_watch", 1)];
    const rows = [{ scenario: "S1", title: "s1", criterion: null, result: "fail", seen: "got a 500", artifacts: ["a.png"] }];
    const events = [
      finished("verifying", 1, "passed", { findings: [], mutation: { score: 0.4, min: 0.6 } }),
      finished("e2e", 1, "failed", { verdict: "fail", criteria: [{ text: "s1", result: "fail" }], manifest: rows }),
      finished("ci_watch", 1, "passed", { class: "flake" }),
    ];
    const withRetries = { ...task, retries: { verify: 2, e2e: 1, ci: 0, total: 4, stronger: 0 } } as unknown as TaskRow;
    const report = verifyReportOf(withRetries, runs, events);
    expect(report).toMatchObject({ review: { engine: "codex:sol", family: "codex" }, mutation: { score: 0.4, min: 0.6 }, ciClass: "flake", rounds: { verify: 2, e2e: 1, ci: 0 } });
    expect(report?.e2e.rows).toEqual(rows);
    expect(VerifyReport.safeParse(report).success).toBe(true);
    const old = { prNumber: null, headSha: null, findings: [], tests: { passed: 0, total: 0 }, coverageDelta: null, e2e: { verdict: null, scenarios: [], artifacts: [] }, envReproduction: null, overrides: [], version: 2 };
    expect(VerifyReport.safeParse(old).success).toBe(true);
  });

  it("marks a finding the next verifying run no longer raises as fixed by the implementer that ran between", () => {
    const runs = [run("verifying", 1), run("implementing", 2, { outputCommit: "fixsha" }), run("verifying", 2, { outputCommit: "v2sha" })];
    const events = [
      finished("verifying", 1, "failed", { findings: [finding("Null deref", 4), finding("Race", 9)] }),
      finished("implementing", 2, "passed"),
      finished("verifying", 2, "passed", { findings: [finding("Race", 9)] }),
    ];
    const byTitle = Object.fromEntries((verifyReportOf(task, runs, events)?.findings ?? []).map((f) => [f.title, f]));
    expect(byTitle["Null deref"]?.resolution).toEqual({ status: "fixed", by: "implementer", inferred: true, commit: "fixsha" });
    expect(byTitle["Race"]?.resolution).toBeUndefined();
  });

  it("merges a finding raised twice, reads a missing PR and counts as null and zero, and is null before verifying ran", () => {
    const runs = [run("verifying", 1)];
    const events = [finished("verifying", 1, "passed", { findings: [finding("Same", 4), finding("Same", 5)] })];
    const report = verifyReportOf({ ...task, testsPassed: null, testsTotal: null } as unknown as TaskRow, runs, events);
    expect(report?.findings).toHaveLength(1);
    expect(report).toMatchObject({ prNumber: null, tests: { passed: 0, total: 0 }, coverageDelta: null, e2e: { verdict: null, scenarios: [] } });
    expect(verifyReportOf(task, [], [])).toBeNull();
  });

  it("falls back to the pr.opened event for the PR number", () => {
    const events = [event("stage.pr.opened", { number: 12 }), finished("verifying", 1, "passed")];
    expect(verifyReportOf(task, [run("verifying", 1)], events)?.prNumber).toBe(12);
  });

  it("reads only what the machine logged: a malformed detail is ignored", () => {
    const events = [finished("verifying", 1, "passed", { findings: "nope", coverage: 5, results: 3 })];
    expect(verifyReportOf(task, [run("verifying", 1)], events)).toMatchObject({ findings: [], coverageDelta: null });
  });
});

describe("buildProgressOf", () => {
  const limits = { max_iterations: 15, max_tokens: 2_000_000, max_minutes: 90, backoff_minutes: [1, 30] as [number, number], regression_full_suite_minutes: 10 };

  it("is null for a card that has not begun to build", () => {
    expect(buildProgressOf([], [], limits)).toBeNull();
    expect(buildProgressOf([run("triage", 1)], [event("scenario.red", { scenario: "S1" })], limits)).toBeNull();
  });

  it("shows each scenario red or green, the budget used against its limits and the last checkpoint, while Build runs", () => {
    const events = [
      event("scenario.red", { scenario: "S1" }),
      event("scenario.red", { scenario: "S2" }),
      event("build.checkpoint", { sha: "a".repeat(40), follows: "red" }),
      event("stage.slice.red", { id: 1 }),
      event("stage.slice.green", { id: 1 }),
      event("build.checkpoint", { sha: "b".repeat(40), follows: "green" }),
      event("scenario.green", { scenario: "S1" }),
      finished("implementing", 1, "failed", {}, { tokens: { input: 900, output: 100 } }),
    ];
    const progress = buildProgressOf([run("implementing", 1, { status: "running", endedAt: null as never })], events, limits, new Date("2026-11-01T10:05:00Z"))!;
    expect(progress.scenarios).toEqual([{ id: "S1", state: "green" }, { id: "S2", state: "red" }]);
    expect(progress.budget).toMatchObject({ iterations: 2, tokens: 1000, minutes: 5, limits: { max_iterations: 15, max_tokens: 2_000_000, max_minutes: 90 } });
    expect(progress.lastCheckpoint).toMatchObject({ sha: "b".repeat(40), follows: "green" });
  });
});

describe("the environment in the reports", () => {
  it("puts the hash Build recorded in the Build Report, and null when none was", () => {
    const runs = [run("implementing", 1, { outputCommit: "abc" })];
    const env = { hash: "f".repeat(64), image: "sha256:i", commit: "abc", lockfiles: {} };
    expect(buildReportOf(task, runs, [finished("implementing", 1, "passed", { env })])?.envHash).toBe("f".repeat(64));
    expect(buildReportOf(task, runs, [finished("implementing", 1, "passed", {})])?.envHash).toBeNull();
    expect(buildReportOf(task, runs, [finished("implementing", 1, "passed", { env: { hash: 7 } })])?.envHash).toBeNull();
  });

  it("puts what Verify's comparison said in the Verify Report, as matched or what differed", () => {
    const runs = [run("verifying", 1)];
    expect(verifyReportOf(task, runs, [finished("verifying", 1, "passed", { envReproduction: "matched" })])?.envReproduction).toBe("matched");
    expect(verifyReportOf(task, runs, [finished("verifying", 1, "failed", { envReproduction: "the runner image differs" })])?.envReproduction).toBe("the runner image differs");
    expect(verifyReportOf(task, runs, [finished("verifying", 1, "passed", {})])?.envReproduction).toBeNull();
  });
});

describe("prFactsOf: what the draft PR's body is fed after Build, Verify and the browser run", () => {
  it("gives the open should_fix and nit findings of the last verifying run, the files Build declared outside the map and each scenario's tagged test", () => {
    const runs = [run("implementing", 1), run("verifying", 1), run("implementing", 2), run("verifying", 2), run("e2e", 1)];
    const soft = (title: string, severity: string) => ({ path: "src/a.ts", line: title.length, severity, title, body: "b", confidence: 0.9 });
    const events = [
      event("scenario.red", { scenario: "S1" }),
      finished("implementing", 1, "passed", { answer: { outOfMap: [{ path: "docs/old.md", reason: "stale" }] } }),
      finished("verifying", 1, "failed", { findings: [soft("old blocker", "blocker")] }),
      finished("implementing", 2, "passed", { answer: { outOfMap: [{ path: "docs/x.md", reason: "the guide named the old flag" }] } }),
      finished("verifying", 2, "passed", { findings: [soft("rename it", "nit"), soft("add a test", "should_fix")] }),
      finished("e2e", 1, "passed", { verdict: "pass" }),
    ];
    const facts = prFactsOf(task, runs, events);
    expect(facts.findings.map((f) => f.title).sort()).toEqual(["add a test", "rename it"]);
    expect(facts.outOfMap).toEqual([{ path: "docs/x.md", reason: "the guide named the old flag" }]);
    expect(facts.tests).toBeInstanceOf(Map);
  });

  it("is empty for a card with no rows", () => {
    expect(prFactsOf(task, [], [])).toEqual({ findings: [], outOfMap: [], tests: new Map() });
  });

  it("maps a scenario to the file of its test from the Build Report", () => {
    const runs = [run("implementing", 1, { outputCommit: "abc" })];
    const events = [finished("implementing", 1, "passed", { testsStep: { scenarioTests: [{ scenario: "S1", file: "src/export.test.ts" }, { scenario: "S2" }] } })];
    const report = buildReportOf(task, runs, events);
    const facts = prFactsOf(task, runs, events);
    expect(report?.tests.map((t) => t.scenario)).toEqual(["S1", "S2"]);
    expect([...facts.tests]).toEqual([["S1", "src/export.test.ts"]]);
  });
});
