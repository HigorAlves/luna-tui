// The verifying stage: run the project's own checks in the task worktree, and only when they
// are green hand the change to the verifying review pack. A red check fails the stage with
// its output as findings, so the next implementing attempt sees what broke.
import type { CheckSpec, CoverageSummary, DecisionOverrides, Finding, ServiceSpec } from "@hardness/contracts";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

import { branchBase, changedPaths as hostChangedPaths, diffText, gitIdentity as hostGitIdentity } from "../../adapters/git/worktree.ts";
import { RepoImageError } from "../repo-images.ts";
import { EgressUnsupportedError } from "../../adapters/docker/egress.ts";
import { blockedPayloads } from "../egress-policy.ts";
import { InstallFailedError } from "../install.ts";
import type { ExecResult } from "../../adapters/process/exec.ts";
import { type GraphJson, blastRadius } from "../../domain/blast-radius.ts";
import { checkCommand, selectChecks, skippedReason } from "../../domain/checks.ts";
import { addedLineNumbers, parseLcov, patchCoverage } from "../../domain/coverage.ts";
import { type EnvRecord, compareEnv } from "../../domain/env-hash.ts";
import { type DetectedChecks, detectChecks } from "../../domain/detect.ts";
import type { StageContext, StageResult, StageRunner } from "../ports.ts";
import { type Decide, judgeCheck } from "./check-decide.ts";

const MINUTE = 60_000;
export const CHECKS_TIMEOUT_MS = 30 * MINUTE;
const TAIL_LINES = 60;
const CHECK_NAMES = ["test", "lint", "typecheck"] as const;

export interface VerifyDeps {
  /** Runs a check command in the runner image; null when there is no sandbox, and then no check runs: the repository's commands never run on the host. */
  exec: ((
    command: string,
    args: string[],
    options: { env?: NodeJS.ProcessEnv; cwd?: string; signal?: AbortSignal; timeoutMs?: number; services?: Record<string, ServiceSpec>; repoPath?: string },
  ) => Promise<ExecResult>) | null;
  /** Runs the verifying review pack; null when agents are off, which skips the review. */
  runPack: ((context: StageContext, extra?: { blastRadius?: string[]; coverage?: CoverageSummary }) => Promise<StageResult>) | null;
  stateDir: string;
  detect?: (worktreePath: string) => Promise<DetectedChecks>;
  /** A fresh clone of the card's clone at its head commit, where the checks and the review run; absent, they run in the card's own folder. */
  fresh?: {
    make: (cardPath: string, branch: string, runId: string) => Promise<{ path: string; commit: string }>;
    bringBack: (cardPath: string, freshPath: string, branch: string, from: string) => Promise<{ ok: boolean; reason?: string }>;
    remove: (path: string) => Promise<void>;
    /** Registers a folder kept after an escalation, to be removed when the keep ends. */
    keep?: (path: string, taskId: string, runId: string) => Promise<void>;
  };
  /** The environment Build recorded for the task (its passing run's `env`); null when none. */
  buildEnv?: (taskId: string) => Promise<EnvRecord | null>;
  /** The environment as it is in `path` at `commit`: the image id and the lockfiles. */
  envOf?: (path: string, commit: string, repoPath?: string) => Promise<EnvRecord>;
  /** Who a check commits as: the identity git resolves for the repo. Null escalates. */
  gitIdentity?: (repoPath: string) => Promise<{ name: string; email: string } | null>;
  /** The repo's luna.yaml: its own checks (null means detect them from the tree) and the
   *  services to run beside each one. */
  policy?: (repoPath: string | null) => Promise<{ checks: CheckSpec[] | null; services: Record<string, ServiceSpec>; decisions?: Record<string, DecisionOverrides> }>;
  /** The files the branch changed, worktree-relative; null when unknown (then every check runs). */
  changedPaths?: (worktreePath: string, repoPath: string) => Promise<string[] | null>;
  /** The machine's code graphs: when the repo has one, the files that depend on the change widen the checks and steer the review. */
  graph?: { currentDir(repoPath: string): string | null };
  /** The branch's diff against where it forked, for the coverage of its added lines; null when unknown. */
  diffSince?: (worktreePath: string, repoPath: string) => Promise<string | null>;
  /** Runs finding_classify on a check context; null (or absent) leaves the review's severities unclassified. Read at call time. */
  decide?: Decide | null;
}

interface CheckReport {
  check?: "none";
  name?: string;
  cmd?: string;
  ok?: boolean;
  tail?: string;
  note?: string;
  /** A luna.yaml check the change did not call for. */
  skipped?: string;
}

const COVERAGE_BODY_LINES = 20;
/** How many findings finding_classify sees, the most confident first, and how much code it gets around each. */
const CLASSIFY_MAX = 6;
const EXCERPT_RADIUS = 8;
const EXCERPT_CAP = 2000;
/** The host reads nothing but a regular file of a sane size from the worktree: a FIFO or a huge file a stage left would stall the machine. */
const EXCERPT_FILE_CAP = 1_000_000;
const REPORT_FILE_CAP = 50_000_000;

/** The text of a regular file under the cap; null for anything else (missing, a directory, a FIFO, too big). */
async function readBounded(path: string, maxBytes: number): Promise<string | null> {
  const info = await stat(path).catch(() => null);
  if (!info?.isFile() || info.size > maxBytes) return null;
  return readFile(path, "utf8").catch(() => null);
}

/** The verifier's severity on the classifier's scale. */
const scaleOf = (severity: string): "blocker" | "should_fix" | "nit" =>
  severity === "bug" || severity === "security" ? "blocker" : severity === "test" || severity === "perf" || severity === "question" ? "should_fix" : "nit";

/** The default diff: the branch's changes since it forked from the repo's HEAD. */
async function branchDiff(worktreePath: string, repoPath: string): Promise<string | null> {
  const base = await branchBase(worktreePath, repoPath);
  return base ? diffText(worktreePath, base, "HEAD") : null;
}

/** A path under the worktree, or null when it climbs out of it (by `..` or by a symlink), or cannot be resolved: closed, never lexical. */
async function pathUnder(worktree: string, relative: string): Promise<string | null> {
  const path = resolve(worktree, relative);
  if (path !== worktree && !path.startsWith(worktree + sep)) return null;
  try {
    const [real, root] = await Promise.all([realpath(path), realpath(worktree)]);
    return real.startsWith(root + sep) ? real : null;
  } catch {
    return null;
  }
}

const tailOf = (text: string): string => text.trimEnd().split("\n").slice(-TAIL_LINES).join("\n");

/** The mechanical fail rule: a confident bug or security finding. */
export const verdictOf = (findings: Finding[]): "pass" | "fail" =>
  findings.some((f) => f.confidence >= 0.8 && (f.severity === "bug" || f.severity === "security")) ? "fail" : "pass";

const answerOf = (detail: Record<string, unknown> | undefined): Record<string, unknown> | undefined => {
  const answer = detail?.answer;
  return answer && typeof answer === "object" ? (answer as Record<string, unknown>) : undefined;
};

/** The file around a finding's line, as it is in the worktree; empty when the path is not under it or has no line. */
async function excerptOf(worktree: string, finding: Finding): Promise<string> {
  if (!finding.path || finding.line < 1) return "";
  const path = await pathUnder(worktree, finding.path);
  const text = path ? await readBounded(path, EXCERPT_FILE_CAP) : null;
  if (text === null) return "";
  return text
    .split("\n")
    .slice(Math.max(0, finding.line - 1 - EXCERPT_RADIUS), finding.line + EXCERPT_RADIUS)
    .join("\n")
    .slice(0, EXCERPT_CAP);
}

export function verifyRunner(deps: VerifyDeps): StageRunner {
  const detect = deps.detect ?? detectChecks;
  const resolveIdentity = deps.gitIdentity ?? hostGitIdentity;
  const repoPolicy: NonNullable<VerifyDeps["policy"]> = deps.policy ?? (async () => ({ checks: null, services: {} }));
  const changed = deps.changedPaths ?? hostChangedPaths;
  const diffSince = deps.diffSince ?? branchDiff;
  /** The files the graph says depend on the change; empty without a graph or a readable one. */
  const radiusOf = async (repoPath: string, changedFiles: string[] | null): Promise<string[]> => {
    const dir = changedFiles && deps.graph?.currentDir(repoPath);
    if (!dir || !changedFiles) return [];
    try {
      return blastRadius(JSON.parse(await readFile(join(dir, "graphify-out", "graph.json"), "utf8")) as GraphJson, changedFiles);
    } catch {
      return [];
    }
  };
  const verify = async (context: StageContext, state: { radius: string[] }): Promise<StageResult> => {
    const { task, signal } = context;
    // No worktree means implementing was stubbed (agents off): behave like the stub, not an escalation.
    if (!task.worktreePath) return { outcome: "pass", detail: { note: "no worktree; implementer was stubbed" } };
    const cwd = task.worktreePath;
    const aborted = (): StageResult => ({ outcome: "fail", detail: { error: "aborted" } });
    if (signal.aborted) return aborted();

    // A suite that commits in a scratch repo (this repo's worktree tests do) needs an author,
    // and the check container has no gitconfig: it gets yours, the one git resolves for the repo.
    const identity = await resolveIdentity(task.repoPath ?? cwd);
    if (!identity) {
      return {
        outcome: "escalated",
        detail: {
          step: "checks",
          reason: `git has no identity for ${task.repoPath ?? cwd}: set user.name and user.email (git config) so checks and commits run as you`,
          options: ["git config user.name / user.email in the repo or globally, then approve"],
        },
      };
    }
    const checkExec = deps.exec;
    if (!checkExec) {
      return { outcome: "escalated", detail: { escalation: "env_broken", step: "checks", reason: "no sandbox is available to run the repository's checks; they never run on the host", options: ["start Docker and the runner image (pnpm images), then resume"] } };
    }
    const identityEnv = {
      GIT_AUTHOR_NAME: identity.name,
      GIT_AUTHOR_EMAIL: identity.email,
      GIT_COMMITTER_NAME: identity.name,
      GIT_COMMITTER_EMAIL: identity.email,
    };
    // Step A: the project's own checks: the luna.yaml list when the repo has one (those the
    // change calls for), else what the tree says.
    const { checks: declared, services, decisions = {} } = await repoPolicy(task.repoPath ?? null);
    const reports: CheckReport[] = [];
    let commands: Array<{ name: string; cmd: string; argv: string[] }>;
    let selectedChecks: CheckSpec[] = [];
    let noTests: boolean;
    const skipped: CheckReport[] = [];
    if (declared) {
      const changedFiles = task.repoPath ? await changed(cwd, task.repoPath) : null;
      state.radius = task.repoPath ? await radiusOf(task.repoPath, changedFiles) : [];
      const selected = selectChecks(declared, changedFiles ? [...changedFiles, ...state.radius] : null);
      selectedChecks = selected;
      commands = selected.map(checkCommand);
      for (const check of declared) if (!selected.includes(check)) skipped.push({ name: check.name, skipped: skippedReason(check) });
      noTests = declared.length === 0;
    } else {
      if (task.repoPath) state.radius = await radiusOf(task.repoPath, await changed(cwd, task.repoPath));
      const found = await detect(cwd);
      commands = CHECK_NAMES.flatMap((name) => (found[name] ? [{ name, cmd: found[name]!.join(" "), argv: found[name]! }] : []));
      noTests = !found.test;
    }
    const log: string[] = [];
    const deadline = Date.now() + CHECKS_TIMEOUT_MS;
    for (const { name, cmd, argv } of commands) {
      const remaining = deadline - Date.now();
      let result: ExecResult;
      let timedOut = false;
      if (remaining <= 0) {
        result = { code: 1, stdout: "", stderr: "skipped: the 30 minute checks budget ran out" };
        timedOut = true;
      } else {
        try {
          result = await checkExec(argv[0]!, argv.slice(1), {
            cwd,
            signal,
            timeoutMs: remaining,
            env: { ...process.env, ...identityEnv, HARDNESS_STAGE: "verifying" },
            services,
            ...(task.repoPath ? { repoPath: task.repoPath } : {}),
          });
        } catch (error) {
          // The repository's image could not be built: an environment problem with the reason, not a crashed stage.
          if (error instanceof InstallFailedError) return { outcome: "escalated", detail: error.detail };
          if (error instanceof EgressUnsupportedError) return { outcome: "escalated", detail: { escalation: "env_broken", envBroken: true, step: "network", reason: error.message, options: ["install Docker Engine 28.0 or newer, or set MACHINE_EGRESS=off on the machine to run without the allow-list, then resume"] } };
          if (!(error instanceof RepoImageError)) throw error;
          return { outcome: "escalated", detail: { escalation: "env_broken", envBroken: true, step: "checks", reason: `the repository's image could not be built: ${error.reason}`, options: ["fix sandbox.image.base in luna.yaml, or remove it to use the machine's image, then resume"] } };
        }
        timedOut = result.code !== 0 && Date.now() >= deadline;
        for (const payload of blockedPayloads((result as { blocked?: Parameters<typeof blockedPayloads>[0] }).blocked, "check")) await Promise.resolve(context.emit?.("sandbox.egress_blocked", payload)).catch(() => {});
      }
      if (signal.aborted) return aborted();
      // The shell's "command not found": the runner image lacks the tool. No implementing
      // attempt can fix that, so this escalates instead of burning the retry cap.
      if (result.code === 127) {
        return {
          outcome: "escalated",
          detail: {
            step: "checks",
            reason: `\`${cmd}\` cannot run: the runner image lacks the tool (exit 127: ${tailOf(result.stderr || result.stdout).trim() || "command not found"})`,
            options: ["add the tool to machine/runner/Dockerfile and rebuild (pnpm images)", "change the repo's test command"],
          },
        };
      }
      const text = `${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}`;
      const tail = tailOf(timedOut ? `${text}\ntimed out: the 30 minute checks budget ran out` : text);
      log.push(`$ ${cmd}\n(exit ${result.code})\n${text}\n`);
      reports.push({ name, cmd, ok: result.code === 0, tail });
    }
    reports.push(...skipped);
    // No test command (a docs, shell or markdown-only repo): the pack still proves each
    // scenario by direct check, so the stage goes on with a note instead of failing here.
    if (noTests) reports.push({ check: "none", note: "no test command detected; verifying proves the scenarios by direct check" });
    const runDir = join(deps.stateDir, "runs", context.runId);
    await mkdir(runDir, { recursive: true });
    const transcriptPath = join(runDir, "checks.log");
    await writeFile(transcriptPath, log.join("\n") || "no checks detected\n");

    const failed = reports.filter((r) => r.ok === false);
    if (failed.length > 0) {
      const findings: Finding[] = failed.map((r) => ({
        path: "",
        line: 0,
        start_line: null,
        severity: "test",
        title: `${r.name} failed`,
        body: r.tail ?? "",
        suggestion_code: null,
        confidence: 1,
      }));
      const list = failed.map((r) => ({ name: r.name, cmd: r.cmd, tail: r.tail }));
      return {
        outcome: "fail",
        detail: {
          step: "checks",
          failed: list,
          summary: `${failed.map((r) => r.name).join(", ")} failed`,
          error: `\`${failed[0]!.cmd}\` failed:\n${(failed[0]!.tail ?? "").slice(-4000)}`,
          findings,
          checks: reports,
        },
        findings,
        run: { transcriptPath },
      };
    }

    // Coverage of the change's added lines, from the report each passing check that names one wrote.
    let coverage: CoverageSummary | null = null;
    const coverageFindings: Finding[] = [];
    for (const check of selectedChecks) {
      if (!check.coverage || !reports.some((r) => r.name === check.name && r.ok === true)) continue;
      const relative = join(check.cwd ?? "", check.coverage);
      const path = await pathUnder(cwd, relative);
      const text = path ? await readBounded(path, REPORT_FILE_CAP) : null;
      if (text === null) {
        reports.push({ name: check.name, note: `coverage report ${check.coverage} not found` });
        continue;
      }
      const diff = await diffSince(cwd, task.repoPath ?? cwd).catch(() => null);
      if (!diff) {
        reports.push({ name: check.name, note: "coverage: the branch's diff is unknown" });
        continue;
      }
      const summary = patchCoverage({ lcov: parseLcov(text, { root: cwd, ...(check.cwd ? { cwd: check.cwd } : {}) }), added: addedLineNumbers(diff), report: relative });
      coverage = coverage ? { files: [...coverage.files, ...summary.files], total: { added: coverage.total.added + summary.total.added, covered: coverage.total.covered + summary.total.covered }, report: coverage.report } : summary;
      for (const f of summary.files) {
        if (f.uncovered.length === 0) continue;
        coverageFindings.push({
          path: f.path,
          line: f.uncovered[0]!,
          start_line: null,
          severity: "test",
          title: `coverage: ${f.covered} of ${f.added} added lines in ${f.path} are not covered`,
          body: `uncovered: ${f.uncovered.slice(0, COVERAGE_BODY_LINES).join(", ")}`,
          suggestion_code: null,
          confidence: 0.9,
        });
      }
    }
    const coverageDetail = coverage ? { coverage } : {};

    /** finding_classify over the review's most confident findings: recorded beside the verifier's severities, never a verdict. */
    const classify = async (reviewed: Finding[]): Promise<Record<string, unknown>> => {
      const decide = deps.decide ?? null;
      if (!decide || reviewed.length === 0) return {};
      const top = [...reviewed].sort((a, b) => b.confidence - a.confidence).slice(0, CLASSIFY_MAX);
      const classified = await Promise.all(
        top.map(async (finding) => {
          const excerpt = await excerptOf(cwd, finding);
          const { verdict, answer, recordId } = await judgeCheck(decide, "finding_classify", { kind: "finding", finding, excerpt }, task.repoPath ?? null, decisions);
          const severity = (answer?.severity ?? null) as { choice?: unknown; confidence?: unknown } | null;
          const usable = (verdict === "proceed" || verdict === "flag") && typeof severity?.choice === "string";
          return {
            title: finding.title,
            path: finding.path,
            line: finding.line,
            severity: finding.severity,
            classified: usable ? (severity!.choice as "blocker" | "should_fix" | "nit") : null,
            confidence: typeof severity?.confidence === "number" ? severity.confidence : null,
            verdict,
            ...(recordId ? { recordId } : {}),
          };
        }),
      );
      const calibration = { agree: 0, disagree: 0, skipped: 0 };
      for (const row of classified) {
        if (row.classified === null) calibration.skipped++;
        else if (row.classified === scaleOf(row.severity)) calibration.agree++;
        else calibration.disagree++;
      }
      return { classified, calibration };
    };

    // Step B: the review pack, only when agents are on.
    const noTestsNote = noTests ? { note: "no test command detected; verifying proves the scenarios by direct check" } : {};
    if (!deps.runPack) {
      return { outcome: "pass", detail: { step: "checks", note: "review: skipped (agents off)", checks: reports, ...coverageDetail }, run: { transcriptPath } };
    }
    const pack = await deps.runPack(context, { ...(state.radius.length ? { blastRadius: state.radius } : {}), ...(coverage ? { coverage } : {}) });
    // A plain failure or a deliberate escalation are both the pack's own answer, verbatim —
    // neither should fall into the verdict computation below (an escalation has no real
    // findings to compute one from, and would otherwise be miscounted as a pass).
    if (pack.outcome === "escalated") {
      return { ...pack, detail: { ...pack.detail, step: "review", checks: reports, ...coverageDetail } };
    }
    const answer = answerOf(pack.detail);
    if (pack.outcome === "fail") {
      const reviewed = (Array.isArray(answer?.findings) ? answer.findings : pack.findings ?? []) as Finding[];
      return { ...pack, detail: { ...pack.detail, step: "review", checks: reports, ...coverageDetail, ...(await classify(reviewed)) } };
    }
    const reviewed = (Array.isArray(answer?.findings) ? answer.findings : pack.findings ?? []) as Finding[];
    const classification = await classify(reviewed);
    const findings = [...reviewed, ...coverageFindings];
    const results = Array.isArray(answer?.results) ? answer.results : [];
    // One verdict per case, by the title the pack copied verbatim from the approved case. The
    // cases are matched by title only: a reworded title is an unproven case, as the prompt says,
    // and the project's own test names are not mapped to cases at all.
    const cases = results.flatMap((r) => {
      const row = r as { title?: unknown; outcome?: unknown };
      return typeof row.title === "string" ? [{ title: row.title, ok: row.outcome === "pass" }] : [];
    });
    const asked = pack.outcome === "needs_input";
    const resultsFailed = results.some((r) => (r as { outcome?: string }).outcome === "fail");
    const verdict =
      !asked && (answer?.verdict === "pass" || answer?.verdict === "fail") ? answer.verdict : verdictOf(findings);
    const summary =
      typeof answer?.summary === "string" ? answer.summary : String(pack.detail?.summary ?? "");
    return {
      ...pack,
      outcome: asked || (verdict === "pass" && !resultsFailed) ? "pass" : "fail",
      detail: {
        step: "review",
        verdict: asked ? "pass" : resultsFailed ? "fail" : verdict,
        summary,
        findings,
        results,
        ...(cases.length > 0 ? { cases } : {}),
        checks: reports,
        ...coverageDetail,
        ...classification,
        ...noTestsNote,
        ...(asked ? { note: "the reviewer asked a question; a reviewer should not, so the review counts as a pass" } : {}),
      },
      findings,
    };
  };
  return async (context) => {
    const state = { radius: [] as string[] };
    const { task } = context;
    const fresh = deps.fresh && task.worktreePath && task.branch ? await deps.fresh.make(task.worktreePath, task.branch, context.runId) : null;
    // Whatever the stage reads and runs is the fresh clone's; the card's folder is only touched to take a fast-forward back.
    const inFresh: StageContext = fresh ? { ...context, task: { ...task, worktreePath: fresh.path } } : context;
    // The environment Verify has, against the one Build recorded: a different image, or a lockfile that differs at the same commit, is a blocker.
    let envReproduction: string | null = null;
    let envFinding: Finding | null = null;
    if (fresh && deps.buildEnv && deps.envOf) {
      const recorded = await deps.buildEnv(task.id);
      if (recorded) {
        const compared = compareEnv(recorded, await deps.envOf(fresh.path, fresh.commit, task.repoPath ?? undefined));
        envReproduction = compared.matched ? "matched" : compared.differences.join("; ");
        if (!compared.matched) {
          envFinding = { path: "", line: 0, start_line: null, severity: "blocker", category: "env", title: "the environment Verify has is not the one Build ran in", body: compared.differences.join("\n"), suggestion_code: null, confidence: 1 };
        }
      }
    }
    let result = envFinding
      ? ({ outcome: "fail", detail: { step: "env", error: envFinding.body, summary: envFinding.title, findings: [envFinding] }, findings: [envFinding] } as StageResult)
      : await verify(inFresh, state);
    if (fresh) {
      // The fresh folder is never the task's workspace.
      const { workspace: _fresh, ...rest } = result;
      result = { ...rest, detail: { ...result.detail, freshClone: { commit: fresh.commit }, ...(envReproduction ? { envReproduction } : {}) } };
      if (result.outcome === "pass") {
        const back = await deps.fresh!.bringBack(task.worktreePath!, fresh.path, task.branch!, fresh.commit);
        if (!back.ok) result = { ...result, outcome: "fail", detail: { ...result.detail, error: `what the verifying stage added could not be brought back: ${back.reason ?? "unknown"}` } };
      }
      // Kept on an escalation, for the person to look at (slice 7 sets how long); removed otherwise.
      if (result.outcome !== "escalated") await deps.fresh!.remove(fresh.path);
      else await deps.fresh!.keep?.(fresh.path, task.id, context.runId);
    }
    return state.radius.length > 0 ? { ...result, detail: { ...result.detail, blastRadius: state.radius } } : result;
  };
}
