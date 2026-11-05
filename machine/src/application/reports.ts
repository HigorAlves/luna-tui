// The v2.2 Build Report and Verify Report, assembled from what the stages already leave: the stage runs,
// the `stage.finished` details, the task's counters. Pure; the caller reads the rows. Reads only the
// machine's own events, never anything a model or a ticket wrote beyond what a stage detail already holds.
import { type BuildReport, CoverageSummary, Finding, type VerifyReport, mergeDuplicateFindings, normaliseFinding } from "@hardness/contracts";

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
export function buildReportOf(task: TaskRow, runs: readonly StageRunRow[], events: readonly EventRow[]): BuildReport | null {
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
  const totalMs = mine.reduce((sum, r) => sum + (durationOf(r) ?? 0), 0);
  return {
    branch: task.branch,
    // Nothing logs the PR's base branch before wave 11.
    base: null,
    headSha: passed.outputCommit,
    // The sandbox's environment hash exists from wave 11.
    envHash: null,
    diffSummary: { added: task.diffAdded, removed: task.diffRemoved, files: stringsOf(facts?.changed) },
    declaredFiles,
    // Tests are tagged with the scenario they prove from wave 10.
    tests: [],
    runs: mine.map((r) => ({ attempt: r.attempt, outcome: r.outcome, engine: r.engine, durationMs: durationOf(r) })),
    // Token counts are recorded from wave 10.
    tokens: null,
    minutes: Math.round((totalMs / 60_000) * 10) / 10,
    scopeCheck: { clean: issues.length === 0, issues },
    version: REPORT_VERSION,
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
      earlier.push({ ...found, resolution: { status: "fixed", by: "implementer", ...(commit ? { commit } : {}) } });
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
