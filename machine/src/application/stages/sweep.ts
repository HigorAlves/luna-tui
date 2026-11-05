// The regression sweep: a repo's own checks, run by script in the stage's container. Build runs it after the implementer's last slice is green
// (the checks whose paths cover the changed files and the files the graph names for them, the cheap whole-suite checks, lint, typecheck and format);
// Verify runs the same commands through `runChecks`. A failing check is a fact with a name and the tail of its output; the machine never asks a model.
import type { CheckSpec, ServiceSpec } from "@hardness/contracts";
import picomatch from "picomatch";

import type { ExecResult } from "../../adapters/process/exec.ts";
import { type CheckCommand, checkCommand } from "../../domain/checks.ts";

const TAIL_LINES = 60;
const GATE_NAME = /lint|type-?check|tsc|format|fmt|prettier|eslint|biome/i;

export const tailOf = (text: string): string => text.trimEnd().split("\n").slice(-TAIL_LINES).join("\n");

/** The checks the sweep runs, in the repo's order: those whose `paths` cover a changed or impacted file (every one with paths when the change is unknown),
 *  the whole-suite checks (no `paths`) whose `minutes` hint is within `wholeSuiteMinutes`, and the lint, typecheck and format checks. */
export function selectSweep(checks: readonly CheckSpec[], changed: readonly string[] | null, impact: readonly string[], wholeSuiteMinutes: number): CheckSpec[] {
  const reach = changed === null ? null : [...changed, ...impact];
  return checks.filter((check) => {
    if (check.paths && check.paths.length > 0) {
      if (reach === null) return true;
      const matches = picomatch(check.paths, { dot: true });
      return reach.some((path) => matches(path));
    }
    return GATE_NAME.test(check.name) || (check.minutes !== undefined && check.minutes <= wholeSuiteMinutes);
  });
}

export interface CheckReport {
  name: string;
  cmd: string;
  ok: boolean;
  tail: string;
}

export interface CheckRun {
  reports: CheckReport[];
  /** One transcript block per command that ran. */
  log: string[];
  aborted: boolean;
  /** Exit 127: the runner image lacks the tool; no implementing attempt can fix that. */
  missingTool?: { cmd: string; tail: string };
}

type Exec = (command: string, args: string[], options: { cwd?: string; signal?: AbortSignal; timeoutMs?: number; env?: NodeJS.ProcessEnv; services?: Record<string, ServiceSpec>; repoPath?: string }) => Promise<ExecResult>;

/** Runs the commands in order inside one budget of `timeoutMs`; a command that finds the budget spent is reported as failed and skipped. */
export async function runChecks(opts: { commands: readonly CheckCommand[]; exec: Exec; cwd: string; signal?: AbortSignal; env: NodeJS.ProcessEnv; services?: Record<string, ServiceSpec>; repoPath?: string; stage: string; timeoutMs: number }): Promise<CheckRun> {
  const reports: CheckReport[] = [];
  const log: string[] = [];
  const deadline = Date.now() + opts.timeoutMs;
  let missingTool: CheckRun["missingTool"];
  for (const { name, cmd, argv } of opts.commands) {
    const remaining = deadline - Date.now();
    let result: ExecResult;
    let timedOut = false;
    if (remaining <= 0) {
      result = { code: 1, stdout: "", stderr: "skipped: the checks budget ran out" };
      timedOut = true;
    } else {
      result = await opts.exec(argv[0]!, argv.slice(1), { cwd: opts.cwd, ...(opts.signal ? { signal: opts.signal } : {}), timeoutMs: remaining, env: { ...opts.env, HARDNESS_STAGE: opts.stage }, ...(opts.services ? { services: opts.services } : {}), ...(opts.repoPath ? { repoPath: opts.repoPath } : {}) });
      timedOut = result.code !== 0 && Date.now() >= deadline;
    }
    if (opts.signal?.aborted) return { reports, log, aborted: true };
    const text = [result.stdout, result.stderr].filter((part) => part !== "").join("\n");
    if (result.code === 127) {
      missingTool = { cmd, tail: tailOf(result.stderr || result.stdout).trim() || "command not found" };
      reports.push({ name, cmd, ok: false, tail: tailOf(text) });
      log.push(`$ ${cmd}\n(exit ${result.code})\n${text}\n`);
      return { reports, log, aborted: false, missingTool };
    }
    log.push(`$ ${cmd}\n(exit ${result.code})\n${text}\n`);
    reports.push({ name, cmd, ok: result.code === 0, tail: tailOf(timedOut ? `${text}\ntimed out: the checks budget ran out` : text) });
  }
  return { reports, log, aborted: false, ...(missingTool ? { missingTool } : {}) };
}

export interface SweepDeps {
  exec: Exec;
  changedPaths: (worktree: string, repoPath: string) => Promise<string[] | null>;
  /** The files the code graph names for a change to `files`: importers, dependents and tests; empty without a graph. */
  impact: (repoPath: string, files: string[]) => Promise<string[]>;
  policy: (repoPath: string) => Promise<{ checks: CheckSpec[] | null; services: Record<string, ServiceSpec>; wholeSuiteMinutes: number }>;
  timeoutMs?: number;
}

export interface SweepOutcome {
  status: "passed" | "failed" | "skipped";
  ran: string[];
  failed: Array<{ name: string; tail: string }>;
  note?: string;
  missingTool?: { cmd: string; tail: string };
  aborted?: boolean;
}

const SWEEP_TIMEOUT_MS = 30 * 60_000;

export async function runSweep(deps: SweepDeps, input: { worktree: string; repoPath: string; signal?: AbortSignal; env: NodeJS.ProcessEnv }): Promise<SweepOutcome> {
  const { checks, services, wholeSuiteMinutes } = await deps.policy(input.repoPath);
  if (!checks || checks.length === 0) return { status: "skipped", ran: [], failed: [], note: "the repository declares no checks, so there was no regression sweep" };
  const changed = await deps.changedPaths(input.worktree, input.repoPath).catch(() => null);
  const impact = changed && changed.length > 0 ? await deps.impact(input.repoPath, changed).catch(() => []) : [];
  const selected = selectSweep(checks, changed, impact, wholeSuiteMinutes);
  if (selected.length === 0) return { status: "skipped", ran: [], failed: [], note: "no check covers the change, so the regression sweep had nothing to run" };
  const run = await runChecks({ commands: selected.map(checkCommand), exec: deps.exec, cwd: input.worktree, ...(input.signal ? { signal: input.signal } : {}), env: input.env, services, repoPath: input.repoPath, stage: "implementing", timeoutMs: deps.timeoutMs ?? SWEEP_TIMEOUT_MS });
  const failed = run.reports.filter((r) => !r.ok).map((r) => ({ name: r.name, tail: r.tail }));
  return { status: failed.length > 0 ? "failed" : "passed", ran: run.reports.map((r) => r.name), failed, ...(run.missingTool ? { missingTool: run.missingTool } : {}), ...(run.aborted ? { aborted: true } : {}) };
}
