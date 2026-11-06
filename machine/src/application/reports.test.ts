import { BuildReport, VerifyReport, findingId } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import type { EventRow, StageRunRow, TaskRow } from "../domain/task.ts";
import { buildReportOf, verifyReportOf } from "./reports.ts";

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
    });
    expect(BuildReport.safeParse(report).success).toBe(true);
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
  it("keeps a finding that moved a line and is still raised unresolved", () => {
    const runs = [run("verifying", 1), run("implementing", 2, { outputCommit: "fixsha" }), run("verifying", 2)];
    const events = [
      finished("verifying", 1, "failed", { findings: [finding("Null deref", 10)] }),
      finished("implementing", 2, "passed"),
      finished("verifying", 2, "failed", { findings: [finding("Null deref", 11)] }),
    ];
    const findings = verifyReportOf(task, runs, events)?.findings ?? [];
    expect(findings).toHaveLength(1);
    expect(findings[0]?.resolution).toBeUndefined();
  });

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
