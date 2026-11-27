// The regression sweep: a repo's own checks, run by script in the stage's container. Build runs it after the implementer's last slice is green
// (the checks whose paths cover the changed files and the files the graph names for them, the cheap whole-suite checks, lint, typecheck and format);
// Verify runs the same commands through `runChecks`. A failing check is a fact with a name and the tail of its output; the machine never asks a model.
import type { CheckSpec, ServiceSpec } from "@hardness/contracts";
import picomatch from "picomatch";

import type { BlockedRow } from "../../adapters/docker/egress.ts";
import type { ExecResult } from "../../adapters/process/exec.ts";
import { type CheckCommand, checkCommand } from "../../domain/checks.ts";
import { isDocPath } from "../../domain/docs-only.ts";
import { envBrokenDetail, noIdentityDetail } from "../env-broken.ts";
import type { Trust } from "../../domain/trust.ts";
import { type SessionExec, openChecksSession } from "./checks-session.ts";

const TAIL_LINES = 60;
const GATE_NAME = /lint|type-?check|tsc|format|fmt|prettier|eslint|biome/i;

/** A line that says what failed, in the common runners (vitest, jest, mocha, pytest, cargo, go, turbo, biome/eslint, tsc), and a run that failed
 *  with no failing test: vitest's unhandled errors and pool timeouts, a worker that died, a heap out of memory (DISC-53: Build was handed only
 *  turbo's "Failed: @discover/api#test:unit"). */
export const FAILING_LINE = /\bFAIL\b|\bFAILED\b|✗|×|✖|AssertionError|error TS\d+|\bpanicked\b|--- FAIL|exited \(\d+\)|\bFailed: \S+#|Tests? +\d+ failed|Test Files +\d+ failed|\(\d+ tests? \| \d+ failed\)|❯ \S+:\d+:\d+|⎯+ Unhandled (?:Errors?|Rejections?) ⎯|Vitest caught \d+ unhandled|\[vitest-(?:pool|worker)\]|\bErrors +\d+ errors?\b|JavaScript heap out of memory|FATAL ERROR:|Worker exited unexpectedly|Worker terminated due to reaching memory limit/;
/** A line a passing test logs on purpose (vitest's `stderr |` header, a caught error it prints): not a failure, however it reads. */
export const LOGGED_LINE = /\bstderr \|/;
/** A file and a line: `src/a.ts:8:1`, `packages/x/y.tsx:12`. */
export const LOCATION = /\S+\.[A-Za-z]{1,5}:\d+/;
/** A linter's diagnostic header with no line number: Biome's `apps/x/a.test.ts format ━━━━`, a file, a rule, a rule of box characters. */
const DIAGNOSTIC_HEADER = /^\s*\S+\.[A-Za-z]{1,5}\s+\S.*━{3,}\s*$/;

/** Where the failing line at `i` happened: the nearest line above it, past up to two blank lines (Biome puts one between its header and its `×`),
 *  when that line names a file (`path:8:1 rule`, or Biome's `path format ━━━`) and is not itself a failure; null for anything else above. */
export function placeOf(lines: readonly string[], i: number): number | null {
  for (let j = i - 1, blanks = 0; j >= 0; j--) {
    const line = lines[j]!;
    if (line.trim() === "") {
      if (++blanks > 2) return null;
      continue;
    }
    return !FAILING_LINE.test(line) && (LOCATION.test(line) || DIAGNOSTIC_HEADER.test(line)) ? j : null;
  }
  return null;
}
const FAILING_MAX = 40;

/** The last lines of a check's output; a longer one that has failing lines ends with them, from wherever they are (DISC-53: turbo's last 60 lines were
 *  all warnings, and the implementer never saw which test failed). The failing lines come last, as the input to Build keeps the end of the text. */
/** Terminal colour and cursor codes: a coloured `FAIL` reads `\u001b[41mFAIL`, which no word boundary finds (DISC-53's vitest output). */
// biome-ignore lint/suspicious/noControlCharactersInRegex: the escape character is what is being removed.
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;

export const tailOf = (text: string): string => {
  const lines = text.replace(ANSI, "").trimEnd().split("\n");
  const last = lines.slice(-TAIL_LINES);
  if (lines.length <= TAIL_LINES) return last.join("\n");
  // Each failing line with the one before it, where a linter or a runner names the file (Biome prints the path above its `×`).
  const head = lines.slice(0, -TAIL_LINES);
  const keep = new Set<number>();
  head.forEach((line, i) => {
    if (!FAILING_LINE.test(line) || LOGGED_LINE.test(line)) return;
    // The line that names the file (Biome's `path:8:1 rule` or `path format ━━━`, a blank line above its `×`): anything else above is a log, not the failure's place.
    const place = placeOf(head, i);
    if (place !== null) keep.add(place);
    keep.add(i);
  });
  const failing = [...keep].sort((a, b) => a - b).map((i) => head[i]!).slice(-FAILING_MAX * 2);
  if (failing.length === 0) return last.join("\n");
  return [...last.slice(-20), "--- failing lines, from the whole output ---", ...failing].join("\n");
};

/** The checks the sweep runs, in the repo's order: those whose `paths` cover a changed or impacted file (every one with paths when the change is unknown),
 *  the whole-suite checks (no `paths`) whose `minutes` hint is within `wholeSuiteMinutes`, and the lint, typecheck and format checks.
 *  A change that is only documentation brings no impact: its checks are those whose `paths` cover the documentation itself. */
export function selectSweep(checks: readonly CheckSpec[], changed: readonly string[] | null, impact: readonly string[], wholeSuiteMinutes: number): CheckSpec[] {
  // A change to documentation alone reaches only what covers the documentation: the graph ties a README to every source file that mentions it,
  // which is no reason to run those files' suites (a README card ran the whole machine suite, 20 minutes, and failed on tests it never touched).
  const proseOnly = changed !== null && changed.length > 0 && changed.every(isDocPath);
  const reach = changed === null ? null : proseOnly ? [...changed] : [...changed, ...impact];
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

type Exec = SessionExec<(command: string, args: string[], options: { cwd?: string; signal?: AbortSignal; timeoutMs?: number; env?: NodeJS.ProcessEnv; services?: Record<string, ServiceSpec>; repoPath?: string; secrets?: string[]; trust?: Trust }) => Promise<ExecResult & { blocked?: BlockedRow[] }>>;

type RunChecksOptions = { commands: readonly CheckCommand[]; exec: Exec; cwd: string; signal?: AbortSignal; env: NodeJS.ProcessEnv; services?: Record<string, ServiceSpec>; repoPath?: string; trust?: Trust; stage: string; timeoutMs: number; onBlocked?: (check: string, rows: BlockedRow[]) => void };

/** Runs the commands in order inside one budget of `timeoutMs`; a command that finds the budget spent is reported as failed and skipped.
 *  The repository's services start once for the whole pass (when the exec can open a session) and are removed when it ends, however it ends. */
export async function runChecks(opts: RunChecksOptions): Promise<CheckRun> {
  const pass = await openChecksSession(opts.exec, { cwd: opts.cwd, ...(opts.trust ? { trust: opts.trust } : {}), ...(opts.repoPath ? { repoPath: opts.repoPath } : {}), ...(opts.services && opts.commands.length > 0 ? { services: opts.services } : {}) });
  try {
    return await runCommands({ ...opts, exec: pass.exec });
  } finally {
    await pass.close();
  }
}

async function runCommands(opts: RunChecksOptions): Promise<CheckRun> {
  const reports: CheckReport[] = [];
  const log: string[] = [];
  const deadline = Date.now() + opts.timeoutMs;
  let missingTool: CheckRun["missingTool"];
  for (const { name, cmd, argv, secrets } of opts.commands) {
    const remaining = deadline - Date.now();
    let result: ExecResult & { blocked?: BlockedRow[] };
    let timedOut = false;
    if (remaining <= 0) {
      result = { code: 1, stdout: "", stderr: "skipped: the checks budget ran out" };
      timedOut = true;
    } else {
      result = await opts.exec(argv[0]!, argv.slice(1), { cwd: opts.cwd, ...(opts.signal ? { signal: opts.signal } : {}), timeoutMs: remaining, env: { ...opts.env, HARDNESS_STAGE: opts.stage }, ...(opts.services ? { services: opts.services } : {}), ...(opts.repoPath ? { repoPath: opts.repoPath } : {}), ...(opts.trust ? { trust: opts.trust } : {}), ...(secrets && secrets.length > 0 ? { secrets } : {}) });
      timedOut = result.code !== 0 && Date.now() >= deadline;
    }
    if (result.blocked?.length) opts.onBlocked?.(name, result.blocked);
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
  /** The identity git resolves for the repository. A suite that commits needs one and the check container has no gitconfig: it gets this one, and with none the sweep escalates (as Verify does) rather than run as nobody. */
  gitIdentity?: (repoPath: string) => Promise<{ name: string; email: string } | null>;
  timeoutMs?: number;
}

export interface SweepOutcome {
  status: "passed" | "failed" | "skipped";
  ran: string[];
  failed: Array<{ name: string; tail: string }>;
  note?: string;
  missingTool?: { cmd: string; tail: string };
  aborted?: boolean;
  /** The environment, not the change, stopped a check (an install that failed, a declared secret that is missing, no isolated network): the stage escalates with this detail. */
  escalated?: Record<string, unknown>;
}

const SWEEP_TIMEOUT_MS = 30 * 60_000;

export async function runSweep(deps: SweepDeps, input: { worktree: string; repoPath: string; trust?: Trust; signal?: AbortSignal; env: NodeJS.ProcessEnv; onBlocked?: (check: string, rows: BlockedRow[]) => void }): Promise<SweepOutcome> {
  const { checks, services, wholeSuiteMinutes } = await deps.policy(input.repoPath);
  if (!checks || checks.length === 0) return { status: "skipped", ran: [], failed: [], note: "the repository declares no checks, so there was no regression sweep" };
  const changed = await deps.changedPaths(input.worktree, input.repoPath).catch(() => null);
  const impact = changed && changed.length > 0 ? await deps.impact(input.repoPath, changed).catch(() => []) : [];
  const selected = selectSweep(checks, changed, impact, wholeSuiteMinutes);
  if (selected.length === 0) return { status: "skipped", ran: [], failed: [], note: "no check covers the change, so the regression sweep had nothing to run" };
  const identity = deps.gitIdentity ? await deps.gitIdentity(input.repoPath) : undefined;
  if (identity === null) return { status: "failed", ran: [], failed: [], escalated: noIdentityDetail(input.repoPath) };
  const env = identity ? { ...input.env, GIT_AUTHOR_NAME: identity.name, GIT_AUTHOR_EMAIL: identity.email, GIT_COMMITTER_NAME: identity.name, GIT_COMMITTER_EMAIL: identity.email } : input.env;
  let run: CheckRun;
  try {
    run = await runChecks({ commands: selected.map(checkCommand), exec: deps.exec, cwd: input.worktree, ...(input.signal ? { signal: input.signal } : {}), env, services, repoPath: input.repoPath, ...(input.trust ? { trust: input.trust } : {}), stage: "implementing", timeoutMs: deps.timeoutMs ?? SWEEP_TIMEOUT_MS, ...(input.onBlocked ? { onBlocked: input.onBlocked } : {}) });
  } catch (error) {
    const escalated = envBrokenDetail(error);
    if (!escalated) throw error;
    return { status: "failed", ran: [], failed: [], escalated };
  }
  const failed = run.reports.filter((r) => !r.ok).map((r) => ({ name: r.name, tail: r.tail }));
  return { status: failed.length > 0 ? "failed" : "passed", ran: run.reports.map((r) => r.name), failed, ...(run.missingTool ? { missingTool: run.missingTool } : {}), ...(run.aborted ? { aborted: true } : {}) };
}
