// The v2.2 Build Report and Verify Report, assembled from what the stages already leave: the stage runs,
// the `stage.finished` details, the task's counters. Pure; the caller reads the rows. Reads only the
// machine's own events, never anything a model or a ticket wrote beyond what a stage detail already holds.
import { type FactoryConfig, type BuildProgress, type BuildReport, type HelperState, CoverageSummary, DiffSummary, Finding, VerifyDesignReport, type VerifyReport, credentialOwner, mergeDuplicateFindings, normaliseFinding, severityOf } from "@hardness/contracts";

import { safe } from "../domain/evidence-markdown.ts";
import { budgetRowsOf, buildBudget } from "../domain/build-budget.ts";
import type { ApprovalRow, EventRow, StageRunRow, TaskRow } from "../domain/task.ts";

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
type BuildLimits = FactoryConfig["build"];

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
  const whole = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;
  const valid = counted.filter((t) => whole(t?.input) && whole(t?.output));
  const tokens = valid.length > 0 ? valid.reduce((sum, t) => sum + (t!.input as number) + (t!.output as number), 0) : null;
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
    // The hash of the environment the passing Build recorded (image, lockfiles, commit).
    envHash: typeof objectOf(finish?.detail.env)?.hash === "string" ? (objectOf(finish?.detail.env)!.hash as string) : null,
    diffSummary: { added: task.diffAdded, removed: task.diffRemoved, files: stringsOf(facts?.changed).slice(0, 200).map((p) => safe(p).slice(0, 300)) },
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
    ...(pickedOf(events).length > 0 ? { picked: pickedOf(events).map((p) => ({ slice: p.slice, shas: p.shas, tip: p.tip })) } : {}),
  };
}

const findingsOf = (detail: Record<string, unknown> | undefined): Finding[] =>
  (Array.isArray(detail?.findings) ? detail.findings : []).flatMap((f) => {
    const parsed = Finding.safeParse(f);
    return parsed.success ? [normaliseFinding(parsed.data)] : [];
  });

/**
 * The last browser run's design block with the design sign-off's waivers applied, and how many findings a person kept by approving. The sign-off belongs to that run when its payload's parity run id is the
 * same (an earlier round's sign-off, sent back, is not read). "Kept at sign-off" is not stored: it is the findings still open on an approved gate. Null when the run left no block that parses.
 */
export function designOf(events: readonly EventRow[], approvals: readonly ApprovalRow[] = []): { report: VerifyDesignReport; kept: number } | null {
  const last = finishes(events).filter((f) => f.stage === "e2e").at(-1);
  const ran = VerifyDesignReport.safeParse(last?.detail.design);
  if (!ran.success) return null;
  const gate = approvals.findLast((a) => a.kind === "awaiting_design" && VerifyDesignReport.safeParse(a.requested.design).data?.parity?.runId === (ran.data.parity?.runId ?? null));
  const signed = gate ? VerifyDesignReport.safeParse(gate.requested.design) : null;
  const report = signed?.success ? signed.data : ran.data;
  const kept = gate?.decision === "approved" ? report.findings.filter((f) => f.resolution?.status !== "waived").length : 0;
  return { report, kept };
}

/** What the draft PR's body is fed, from the rows of Build, Verify and the browser run (Deliver runs after all three): the open findings of the last verifying run that are not blockers
 *  (a blocker fails the stage), the files Build declared outside the map and the file of each scenario's tagged test. */
export function prFactsOf(task: TaskRow, runs: readonly StageRunRow[], events: readonly EventRow[], approvals: readonly ApprovalRow[] = []): { findings: Finding[]; outOfMap: Array<{ path: string; reason: string }>; tests: Map<string, string>; design?: { report: VerifyDesignReport; kept: number } } {
  const build = buildReportOf(task, runs, events);
  const last = finishes(events).filter((f) => f.stage === "verifying").at(-1);
  const design = designOf(events, approvals);
  return {
    ...(design ? { design } : {}),
    findings: findingsOf(last?.detail).filter((f) => !f.resolution && severityOf(f.severity) !== "blocker"),
    outOfMap: build?.declaredFiles ?? [],
    tests: new Map((build?.tests ?? []).flatMap((t) => (t.file ? [[t.scenario, t.file] as [string, string]] : []))),
  };
}

/** What Verify hands to Evidence; null until a verifying run has happened. */
export function verifyReportOf(task: TaskRow, runs: readonly StageRunRow[], events: readonly EventRow[], approvals: readonly ApprovalRow[] = []): VerifyReport | null {
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
  const design = designOf(events, approvals);
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
      ...(manifestRowsOf(e2e?.detail.manifest) ? { rows: manifestRowsOf(e2e?.detail.manifest)! } : {}),
    },
    // What Verify's comparison of its environment with Build's said; a person's override of a verdict is from wave 12.
    envReproduction: typeof last?.detail.envReproduction === "string" ? last.detail.envReproduction : null,
    overrides: [],
    version: REPORT_VERSION,
    review: { engine: lastRun.engine ?? null, family: lastRun.engine ? credentialOwner(lastRun.engine) : null },
    mutation: mutationOf(last?.detail.mutation),
    ciClass: typeof all.findLast((f) => f.stage === "ci_watch")?.detail.class === "string" ? (all.findLast((f) => f.stage === "ci_watch")!.detail.class as string) : null,
    ...(task.retries ? { rounds: { verify: task.retries.verify, e2e: task.retries.e2e, ci: task.retries.ci } } : {}),
    ...(design ? { design: design.report } : {}),
  };
}

const manifestRowsOf = (value: unknown): NonNullable<VerifyReport["e2e"]["rows"]> | null => {
  if (!Array.isArray(value)) return null;
  const rows = value.flatMap((v) => {
    const r = objectOf(v);
    return r && typeof r.scenario === "string" && typeof r.title === "string" && typeof r.result === "string" && typeof r.seen === "string" && Array.isArray(r.artifacts)
      ? [{ scenario: r.scenario, title: r.title, criterion: typeof r.criterion === "string" ? r.criterion : null, result: r.result, seen: r.seen, artifacts: r.artifacts.filter((a): a is string => typeof a === "string") }]
      : [];
  });
  return rows.length > 0 ? rows : null;
};

const mutationOf = (value: unknown): { score: number; min: number } | null => {
  const m = objectOf(value);
  return typeof m?.score === "number" && typeof m.min === "number" ? { score: m.score, min: m.min } : null;
};

const SHA = /^[0-9a-f]{40,64}$/;

/** The slices the machine put on the branch: its own `build.helper_picked` rows, the last one per slice, with a well-formed slice, shas and tip. A container cannot write one (the kind is reserved). */
function pickedOf(events: readonly EventRow[]): Array<{ slice: number; shas: string[]; tip: string }> {
  const bySlice = new Map<number, { slice: number; shas: string[]; tip: string }>();
  for (const { kind, payload } of events) {
    if (kind !== "build.helper_picked") continue;
    const { slice, picked, tip } = payload;
    if (typeof slice !== "number" || !Number.isInteger(slice) || slice < 1 || !Array.isArray(picked) || picked.length === 0 || !picked.every((p) => typeof p === "string" && SHA.test(p)) || typeof tip !== "string" || !SHA.test(tip)) continue;
    bySlice.set(slice, { slice, shas: picked as string[], tip });
  }
  return [...bySlice.values()].sort((a, b) => a.slice - b.slice);
}

type HelperRow = { kind: string; payload: Record<string, unknown>; at: Date };

/** Where one slice's latest helper stands, from the machine's rows after the newest start: a pick is `committed`, a second conflict `merge_conflict`, a first one waits for its re-run, a refusal is `refused`, a pass nobody took yet is `returned`, anything else that ended is `failed` (or `cancelled` when the run said so). */
function helperStateOf(rows: readonly HelperRow[]): HelperState {
  if (rows.some((r) => r.kind === "build.helper_picked")) return "committed";
  const last = rows.findLast((r) => r.kind !== "build.helper_ended" && r.kind !== "build.helper_started");
  if (last?.kind === "build.helper_refused") return "refused";
  if (last?.kind === "build.helper_conflict") return typeof last.payload.attempt === "number" && last.payload.attempt >= 2 ? "merge_conflict" : "conflict_rerun";
  const ended = rows.findLast((r) => r.kind === "build.helper_ended");
  if (!ended) return "running";
  if (ended.payload.outcome === "pass") return "returned";
  return ended.payload.outcome === "cancelled" ? "cancelled" : "failed";
}

/** Each slice's owner and the latest helper, from the machine's own rows. A slice is the ui-designer's while its helper is out, when its commits are waiting to be picked and once they landed; any other end gives it back to the implementer. */
function helpersOf(events: readonly EventRow[]): { slices: NonNullable<BuildProgress["slices"]>; helper: BuildProgress["helper"] } {
  const owned = new Map<number, HelperRow[]>();
  const sliceIds = new Set<number>();
  let latest: { slice: number; at: Date; branch: string; attempt: number } | null = null;
  for (const { kind, payload, at } of events) {
    // A container's own ledger rows name the slices; whoever wrote them, they never say who owns one.
    if ((kind === "stage.slice.red" || kind === "stage.slice.green" || kind === "stage.slice.committed") && payload.by !== "ui-designer") {
      const id = payload.id;
      if (typeof id === "number" && Number.isInteger(id) && id >= 1) sliceIds.add(id);
      continue;
    }
    if (!kind.startsWith("build.helper_")) continue;
    const slice = payload.slice;
    if (typeof slice !== "number" || !Number.isInteger(slice) || slice < 1) continue;
    sliceIds.add(slice);
    if (kind === "build.helper_started") {
      owned.set(slice, [{ kind, payload, at }]);
      const branch = typeof payload.branch === "string" ? payload.branch : "";
      const attempt = typeof payload.attempt === "number" ? payload.attempt : 1;
      latest = { slice, at, branch, attempt };
    } else if (owned.has(slice) || kind === "build.helper_picked") (owned.get(slice) ?? owned.set(slice, []).get(slice)!).push({ kind, payload, at });
  }
  const states = new Map([...owned].filter(([, rows]) => rows.length > 0).map(([slice, rows]) => [slice, helperStateOf(rows)] as const));
  const picked = new Map(pickedOf(events).map((p) => [p.slice, p.shas]));
  const slices = [...sliceIds].sort((a, b) => a - b).map((slice) => {
    const state = states.get(slice);
    const shas = picked.get(slice);
    const owner = state === "running" || state === "returned" || state === "conflict_rerun" || state === "committed" || shas ? ("ui-designer" as const) : ("implementer" as const);
    return { slice, owner, ...(shas ? { picked: shas } : {}) };
  });
  const state = latest ? states.get(latest.slice) : undefined;
  return { slices, helper: latest && state ? { slice: latest.slice, state, attempt: latest.attempt, branch: latest.branch, startedAt: latest.at.toISOString() } : null };
}

const SCENE_ID = /^[A-Za-z0-9_-]{1,40}$/;

/** Build while it runs: each scenario red or green (from the `scenario.red` and `scenario.green` rows), the budget used against its limits, the last checkpoint pushed. Null for a card that has not begun to build. */
export function buildProgressOf(runs: readonly StageRunRow[], events: readonly EventRow[], limits: BuildLimits, now: Date = new Date()): BuildProgress | null {
  if (!runs.some((r) => r.stage === "implementing")) return null;
  const state = new Map<string, "red" | "green">();
  for (const { kind, payload } of events) {
    const id = payload.scenario;
    if ((kind === "scenario.red" || kind === "scenario.green") && typeof id === "string" && SCENE_ID.test(id)) state.set(id, kind === "scenario.green" ? "green" : state.get(id) === "green" ? "green" : "red");
  }
  const counted = budgetRowsOf(runs, events);
  const budget = buildBudget(counted.runs, counted.events, limits, now);
  const checkpoint = events.findLast((e) => e.kind === "build.checkpoint" && typeof e.payload.sha === "string" && /^[0-9a-f]{7,64}$/.test(e.payload.sha) && (e.payload.follows === "red" || e.payload.follows === "green"));
  return {
    scenarios: [...state].map(([id, s]) => ({ id, state: s })),
    budget: { iterations: budget.iterations, tokens: budget.tokens, minutes: budget.minutes, limits: { max_iterations: limits.max_iterations, max_tokens: limits.max_tokens, max_minutes: limits.max_minutes } },
    lastCheckpoint: checkpoint ? { sha: checkpoint.payload.sha as string, follows: checkpoint.payload.follows as "red" | "green", at: checkpoint.at.toISOString() } : null,
    ...helpersOf(events),
  };
}
