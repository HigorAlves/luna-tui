// The v2.2 Build Report and Verify Report, assembled from what the stages already leave: the stage runs,
// the `stage.finished` details, the task's counters. Pure; the caller reads the rows. Reads only the
// machine's own events, never anything a model or a ticket wrote beyond what a stage detail already holds.
import { type BuildReport, CoverageSummary, DiffSummary, Finding, type VerifyReport, mergeDuplicateFindings, normaliseFinding } from "@hardness/contracts";

import type { EventRow, StageRunRow, TaskRow } from "../domain/task.ts";

const REPORT_VERSION = 2;

const objectOf = (value: unknown): Record<string, unknown> | undefined => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined);
const stringsOf = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);

interface Finish {
  stage: string;
  attempt: number;
  status: string;
  detail: Record<string, unknown>;
}

/** The `stage.finished` events, oldest first. */
function finishes(events: readonly EventRow[]): Finish[] {
  return events.flatMap((e) => {
    if (e.kind !== "stage.finished" || typeof e.payload.stage !== "string") return [];
    return [{ stage: e.payload.stage, attempt: Number(e.payload.attempt ?? 0), status: String(e.payload.status ?? ""), detail: objectOf(e.payload.detail) ?? {} }];
  });
}

const durationOf = (r: StageRunRow): number | null => (r.endedAt ? r.endedAt.getTime() - r.startedAt.getTime() : null);

/** What Build hands to Verify; null until an implementing run has passed. */
type BuildLimits = { max_iterations: number; max_tokens: number; max_minutes: number };

/** The iteration log: each red or green the ledger reported (a commit fills the sha of its slice's green) and each failed sweep, in order. */
function iterationsOf(events: readonly EventRow[]): NonNullable<BuildReport["iterations"]> {
  const log: NonNullable<BuildReport["iterations"]> = [];
  for (const { kind, payload } of events) {
    const slice = `slice ${String(payload.id ?? "?")}`;
    if (kind === "stage.slice.red") log.push({ kind: "red", ref: slice, sha: null });
    else if (kind === "stage.slice.green") log.push({ kind: "green", ref: slice, sha: null });
    else if (kind === "stage.slice.committed" && typeof payload.commit === "string") {
      const green = log.findLast((i) => i.kind === "green" && i.ref === slice && i.sha === null);
      if (green) green.sha = payload.commit;
    } else if (kind === "build.sweep_failed") {
      for (const check of stringsOf(payload.checks)) log.push({ kind: "sweep", ref: check, sha: null });
    }
  }
  return log;
}

export function buildReportOf(task: TaskRow, runs: readonly StageRunRow[], events: readonly EventRow[], limits?: BuildLimits | null): BuildReport | null {
  const mine = runs.filter((r) => r.stage === "implementing");
  const passed = mine.filter((r) => r.status === "passed").at(-1);
  if (!passed) return null;
  const finish = finishes(events).filter((f) => f.stage === "implementing" && f.status === "passed").at(-1);
  const facts = objectOf(objectOf(finish?.detail.scope)?.facts);
  const undeclared = stringsOf(facts?.undeclared);
  const removedTests = stringsOf(facts?.removedTests);
  const issues = [...undeclared.map((p) => `not in the plan and not declared: ${p}`), ...removedTests.map((p) => `test removed: ${p}`)];
  const declaredFiles = (Array.isArray(objectOf(finish?.detail.answer)?.outOfMap) ? (objectOf(finish?.detail.answer)!.outOfMap as unknown[]) : []).flatMap((o) => {
    const item = objectOf(o);
    return typeof item?.path === "string" && typeof item.reason === "string" ? [{ path: item.path, reason: item.reason }] : [];
  });
  const issueRows: NonNullable<BuildReport["scopeCheck"]["severities"]> = (Array.isArray(objectOf(finish?.detail.scope)?.issues) ? (objectOf(finish?.detail.scope)!.issues as unknown[]) : []).flatMap((i) => {
    const item = objectOf(i);
    const severity = item?.severity;
    return (severity === "blocker" || severity === "should_fix" || severity === "nit") && typeof item?.kind === "string" && typeof item.text === "string" ? [{ severity, kind: item.kind, text: item.text }] : [];
  });
  const counted = events.flatMap((e) => (e.kind === "stage.finished" && e.payload.stage === "implementing" ? [objectOf(e.payload.tokens)] : []));
  const tokens = counted.some((t) => typeof t?.input === "number" && typeof t.output === "number") ? counted.reduce((sum, t) => sum + (typeof t?.input === "number" && typeof t.output === "number" ? t.input + t.output : 0), 0) : null;
  const step = objectOf(finish?.detail.testsStep);
  const planned = (Array.isArray(step?.scenarioTests) ? (step!.scenarioTests as unknown[]) : []).flatMap((t) => {
    const item = objectOf(t);
    return typeof item?.scenario === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(item.scenario) ? [{ scenario: item.scenario, file: typeof item.file === "string" ? item.file : null }] : [];
  });
  const sceneRows = (name: string) => new Set(events.filter((e) => e.kind === name && typeof e.payload.scenario === "string").map((e) => e.payload.scenario as string));
  const reds = sceneRows("scenario.red");
  const greens = sceneRows("scenario.green");
  const summary = DiffSummary.safeParse(finish?.detail.diffSummary);
  const sweep = objectOf(finish?.detail.sweep);
  const totalMs = mine.reduce((sum, r) => sum + (durationOf(r) ?? 0), 0);
  return {
    branch: task.branch,
    base: typeof finish?.detail.base === "string" ? finish.detail.base : null,
    headSha: passed.outputCommit,
    // The sandbox's environment hash exists from wave 11.
    envHash: null,
    diffSummary: { added: task.diffAdded, removed: task.diffRemoved, files: stringsOf(facts?.changed) },
    declaredFiles,
    tests: planned.map((t) => ({ scenario: t.scenario, file: t.file, before: reds.has(t.scenario) ? ("fail" as const) : null, after: greens.has(t.scenario) ? ("pass" as const) : null })),
    runs: mine.map((r) => ({ attempt: r.attempt, outcome: r.outcome, engine: r.engine, durationMs: durationOf(r) })),
    tokens,
    minutes: Math.round((totalMs / 60_000) * 10) / 10,
    scopeCheck: issueRows.length > 0 ? { clean: issueRows.every((i) => i.severity === "nit"), issues: issueRows.map((i) => i.text), severities: issueRows } : { clean: issues.length === 0, issues },
    version: REPORT_VERSION,
    iterations: iterationsOf(events),
    summary: summary.success ? summary.data : null,
    limits: limits ? { max_iterations: limits.max_iterations, max_tokens: limits.max_tokens, max_minutes: limits.max_minutes } : null,
    testsStep: step && typeof step.status === "string" ? { status: step.status, ...(typeof step.why === "string" ? { why: step.why } : {}), ...(typeof step.commit === "string" ? { commit: step.commit } : {}), ...(typeof step.redCheck === "string" ? { redCheck: step.redCheck } : {}) } : null,
    sweep: sweep && typeof sweep.status === "string" ? { status: sweep.status, ran: stringsOf(sweep.ran), ...(typeof sweep.note === "string" ? { note: sweep.note } : {}), ...(stringsOf(sweep.failed).length ? { failed: stringsOf(sweep.failed) } : {}) } : null,
  };
}

const findingsOf = (detail: Record<string, unknown> | undefined): Finding[] =>
  (Array.isArray(detail?.findings) ? detail.findings : []).flatMap((f) => {
    const parsed = Finding.safeParse(f);
    return parsed.success ? [normaliseFinding(parsed.data)] : [];
  });

/** What Verify hands to Evidence; null until a verifying run has happened. */
export function verifyReportOf(task: TaskRow, runs: readonly StageRunRow[], events: readonly EventRow[]): VerifyReport | null {
  const verifyingRuns = runs.filter((r) => r.stage === "verifying");
  if (verifyingRuns.length === 0) return null;
  const all = finishes(events);
  const verifying = all.filter((f) => f.stage === "verifying");
  const last = verifying.at(-1);

  // A finding an earlier verifying run raised and the last one does not is fixed, by the implementing run in between.
  const still = new Set(findingsOf(last?.detail).map((f) => f.id));
  const lastAt = last ? all.lastIndexOf(last) : all.length;
  const earlier: Finding[] = [];
  for (const f of verifying.slice(0, -1)) {
    const at = all.indexOf(f);
    const fixer = all.slice(at + 1, lastAt).findLast((x) => x.stage === "implementing" && x.status === "passed");
    const commit = fixer ? runs.find((r) => r.stage === "implementing" && r.attempt === fixer.attempt && r.status === "passed")?.outputCommit : null;
    for (const found of findingsOf(f.detail)) {
      if (still.has(found.id) || !fixer) continue;
      earlier.push({ ...found, resolution: { status: "fixed", by: "implementer", inferred: true, ...(commit ? { commit } : {}) } });
    }
  }
  const findings = mergeDuplicateFindings([...earlier, ...findingsOf(last?.detail)]);

  const e2e = all.filter((f) => f.stage === "e2e").at(-1);
  const results = Array.isArray(last?.detail.results) ? last.detail.results : [];
  const coverage = CoverageSummary.safeParse(last?.detail.coverage);
  const opened = events.findLast((e) => e.kind === "stage.pr.opened");
  const prNumber = all.findLast((f) => f.stage === "delivering" && typeof f.detail.prNumber === "number")?.detail.prNumber ?? opened?.payload.number;
  const lastRun = verifyingRuns.at(-1)!;
  return {
    prNumber: typeof prNumber === "number" ? prNumber : null,
    headSha: lastRun.outputCommit ?? lastRun.inputCommit,
    findings,
    tests: { passed: task.testsPassed ?? results.filter((r) => objectOf(r)?.outcome === "pass").length, total: task.testsTotal ?? results.length },
    coverageDelta: coverage.success ? coverage.data : null,
    e2e: {
      verdict: typeof e2e?.detail.verdict === "string" ? e2e.detail.verdict : null,
      scenarios: (Array.isArray(e2e?.detail.criteria) ? e2e.detail.criteria : []).flatMap((c) => {
        const row = objectOf(c);
        return typeof row?.text === "string" && typeof row.result === "string" ? [{ text: row.text, result: row.result }] : [];
      }),
      // The browser run's files are Evidence's: the pack's media lists them.
      artifacts: [],
    },
    // The sandbox's reproduction of a failure exists from wave 11; a person's override of a verdict from wave 12.
    envReproduction: null,
    overrides: [],
    version: REPORT_VERSION,
  };
}
