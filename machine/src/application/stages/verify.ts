// The verifying stage, in the diagram's order: the review pack reads the change first, and only when no
// blocker stands do the project's own checks run in the task worktree. A blocker fails the stage with the
// findings and no suite run; a red check fails it with its output as a finding of category `tests`.
import { FACTORY_DEFAULTS, type CheckSpec, type FactoryConfig, type CoverageSummary, type DecisionOverrides, type Finding, type ServiceSpec, mergeDuplicateFindings, normaliseFinding, severityOf } from "@hardness/contracts";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

import { branchBase, branchDiffStat, changedPaths as hostChangedPaths, diffText, gitIdentity as hostGitIdentity } from "../../adapters/git/worktree.ts";
import { RepoImageError } from "../repo-images.ts";
import { EgressUnsupportedError } from "../../adapters/docker/egress.ts";
import { blockedPayloads } from "../egress-policy.ts";
import { InstallFailedError } from "../install.ts";
import { SecretsMissingError } from "../../adapters/docker/docker.ts";
import type { ExecResult } from "../../adapters/process/exec.ts";
import { type GraphJson, blastRadius } from "../../domain/blast-radius.ts";
import { failingTestFiles, narrowedArgv } from "../../domain/base-rerun.ts";
import { checkCommand, selectChecks, skippedReason } from "../../domain/checks.ts";
import { failureGist } from "../../domain/failure-gist.ts";
import { addedLineNumbers, coverageFinding, mutationFinding, parseLcov, parseMutationScore, patchCoverage } from "../../domain/coverage.ts";
import { type EnvRecord, compareEnv } from "../../domain/env-hash.ts";
import { verifySteps } from "../../domain/verify-order.ts";
import { type DetectedChecks, detectChecks } from "../../domain/detect.ts";
import { noIdentityDetail } from "../env-broken.ts";
import type { StageContext, StageResult, StageRunner } from "../ports.ts";
import { type Decide, judgeCheck } from "./check-decide.ts";
import { type SessionExec, openChecksSession } from "./checks-session.ts";

const MINUTE = 60_000;
export const CHECKS_TIMEOUT_MS = 30 * MINUTE;
const TAIL_LINES = 60;
const CHECK_NAMES = ["test", "lint", "typecheck"] as const;

export interface VerifyDeps {
  /** Runs a check command in the runner image; null when there is no sandbox, and then no check runs: the repository's commands never run on the host. */
  exec: SessionExec<(
    command: string,
    args: string[],
    options: { env?: NodeJS.ProcessEnv; cwd?: string; signal?: AbortSignal; timeoutMs?: number; services?: Record<string, ServiceSpec>; repoPath?: string; image?: string },
  ) => Promise<ExecResult>> | null;
  /** Runs the verifying review pack; null when agents are off, which skips the review. */
  runPack: ((context: StageContext, extra?: { blastRadius?: string[]; coverage?: CoverageSummary; image?: string }) => Promise<StageResult>) | null;
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
  envOf?: (path: string, commit: string, repoPath?: string, image?: string) => Promise<EnvRecord>;
  /** The repository's image as the stages run in it now. Read once per run: the comparison, the checks and the review all use that one answer, never a second resolution. */
  imageOf?: (repoPath: string, signal?: AbortSignal) => Promise<string>;
  /** Who a check commits as: the identity git resolves for the repo. Null escalates. */
  gitIdentity?: (repoPath: string) => Promise<{ name: string; email: string } | null>;
  /** The repo's luna.yaml: its own checks (null means detect them from the tree) and the
   *  services to run beside each one. */
  policy?: (repoPath: string | null) => Promise<{ checks: CheckSpec[] | null; services: Record<string, ServiceSpec>; decisions?: Record<string, DecisionOverrides>; /** The repository's `size` section (the hard limit). */ size?: FactoryConfig["size"]; /** The repository's `verify` section: the coverage bar and the mutation hook; the defaults of `FACTORY_DEFAULTS.verify` when absent. */ verify?: { coverage_drop_max?: number; mutation?: { command: string | null; min_score: number } } }>;
  /** The files the branch changed, worktree-relative; null when unknown (then every check runs). */
  changedPaths?: (worktreePath: string, repoPath: string) => Promise<string[] | null>;
  /** The machine's code graphs: when the repo has one, the files that depend on the change widen the checks and steer the review. */
  graph?: { currentDir(repoPath: string): string | null };
  /** The branch's diff against where it forked, for the coverage of its added lines; null when unknown. */
  diffSince?: (worktreePath: string, repoPath: string) => Promise<string | null>;
  /** The counted diff of the card's own change (lines added and removed against where its branch forked); null when unknown. Absent, the size is not counted. */
  diffStat?: (worktreePath: string, repoPath: string | null) => Promise<{ added: number; removed: number } | null>;
  /** Where a failing check is asked again, on the commit the card's change is measured from, so that a failure the environment causes is not blamed on the change.
   *  Absent, a red check is the card's. */
  baseline?: {
    /** The commit the change is measured from; null when unknown. Default: where the branch left the repository's HEAD (or its parent's branch, for a stacked card). */
    base?: (worktreePath: string, repoPath: string) => Promise<string | null>;
    /** A throwaway clone of the card's repository at `sha`, on `branch`: made like the fresh clone Verify runs in, never the card's own folder. */
    clone: (cardPath: string, branch: string, runId: string, sha: string) => Promise<{ path: string }>;
    remove: (path: string) => Promise<void>;
    /** What was asked, by (base, image, check, files); one for the process by default, so a second card on the same base asks nothing. */
    cache?: Map<string, BaseAnswer>;
  };
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

/** Whether a check fails on the base too, and when that was asked. */
export interface BaseAnswer {
  red: boolean;
  at: number;
}
const SHA = /^[0-9a-f]{40,64}$/;
const BASE_CACHE_CAP = 500;
const BASE_CHECK_TIMEOUT_MS = 15 * MINUTE;
/** A green answer holds for a while (a base commit does not change). A red one is short-lived: the environment it names (a service that was down) is fixed without the image or the commit changing, and the retry must ask again. */
const GREEN_TTL_MS = 30 * MINUTE;
const RED_TTL_MS = 2 * MINUTE;
const baseCache = new Map<string, BaseAnswer>();
const remember = (cache: Map<string, BaseAnswer>, key: string, answer: BaseAnswer): void => {
  if (cache.size >= BASE_CACHE_CAP) cache.delete(cache.keys().next().value!);
  cache.set(key, answer);
};
const stillFresh = (answer: BaseAnswer | undefined): answer is BaseAnswer => !!answer && Date.now() - answer.at < (answer.red ? RED_TTL_MS : GREEN_TTL_MS);

/** How many findings finding_classify sees, the most severe first, and how much code it gets around each. */
const CLASSIFY_MAX = 20;
const LEVEL_RANK = { blocker: 2, should_fix: 1, nit: 0 } as const;
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

/** The mechanical fail rule: a confident finding at the blocker level (`blocker`, or the older `bug` and `security`). Only a blocker fails the stage. */
export const verdictOf = (findings: Finding[]): "pass" | "fail" =>
  findings.some((f) => f.confidence >= 0.8 && severityOf(f.severity) === "blocker") ? "fail" : "pass";

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

/** A check that could not start because of the environment is an escalation with the step named, not a crashed stage; null for any other error. */
function escalationOf(error: unknown): StageResult | null {
  // The install failed, or a declared secret is missing: the step's own detail.
  if (error instanceof InstallFailedError || error instanceof SecretsMissingError) return { outcome: "escalated", detail: error.detail };
  if (error instanceof EgressUnsupportedError) return { outcome: "escalated", detail: { escalation: "env_broken", envBroken: true, step: "network", reason: error.message, options: ["install Docker Engine 28.0 or newer, or set MACHINE_EGRESS=off on the machine to run without the allow-list, then resume"] } };
  // The repository's image could not be built: an environment problem with the reason.
  if (error instanceof RepoImageError) return { outcome: "escalated", detail: { escalation: "env_broken", envBroken: true, step: "checks", reason: `the repository's image could not be built: ${error.reason}`, options: ["fix sandbox.image.base in luna.yaml, or remove it to use the machine's image, then resume"] } };
  return null;
}

export function verifyRunner(deps: VerifyDeps): StageRunner {
  const detect = deps.detect ?? detectChecks;
  const resolveIdentity = deps.gitIdentity ?? hostGitIdentity;
  const repoPolicy: NonNullable<VerifyDeps["policy"]> = deps.policy ?? (async () => ({ checks: null, services: {} }));
  const changed = deps.changedPaths ?? hostChangedPaths;
  const diffSince = deps.diffSince ?? branchDiff;
  const diffStat = deps.diffStat ?? branchDiffStat;
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
  const verify = async (context: StageContext, state: { radius: string[]; image?: string }): Promise<StageResult> => {
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
      return { outcome: "escalated", detail: noIdentityDetail(task.repoPath ?? cwd) };
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
    const { checks: declared, services, decisions = {}, verify: verifyConfig } = await repoPolicy(task.repoPath ?? null);
    const coverageDropMax = verifyConfig?.coverage_drop_max ?? FACTORY_DEFAULTS.verify.coverage_drop_max;
    const mutationConfig = verifyConfig?.mutation ?? FACTORY_DEFAULTS.verify.mutation;
    const reports: CheckReport[] = [];
    let commands: Array<{ name: string; cmd: string; argv: string[]; secrets?: string[] }>;
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
    // The review's result as the stage returns it: its verdict, results and cases, with whatever else the stage found.
    const assemble = (pack: StageResult, findings: Finding[], extra: Record<string, unknown>): StageResult => {
      const answer = answerOf(pack.detail);
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
      // The verifier's own verdict can only tighten what the findings say: a confident blocker fails the stage whatever it answers, and a question is not a pass.
      const verdict = verdictOf(findings) === "fail" || (!asked && answer?.verdict === "fail") ? "fail" : "pass";
      const summary = typeof answer?.summary === "string" ? answer.summary : String(pack.detail?.summary ?? "");
      return {
        ...pack,
        outcome: verdict === "pass" && !resultsFailed ? "pass" : "fail",
        detail: {
          step: "review",
          verdict: resultsFailed ? "fail" : verdict,
          summary,
          findings,
          results,
          ...(cases.length > 0 ? { cases } : {}),
          ...extra,
          ...(asked ? { note: "the reviewer asked a question; a reviewer should not, so the review counts as a pass" } : {}),
        },
        findings,
      };
    };

    /** finding_classify over the review's most confident findings: recorded beside the verifier's severities, never a verdict. */
    const classify = async (reviewed: Finding[]): Promise<Record<string, unknown>> => {
      const decide = deps.decide ?? null;
      if (!decide || reviewed.length === 0) return {};
      const top = [...reviewed].sort((a, b) => LEVEL_RANK[severityOf(b.severity)] - LEVEL_RANK[severityOf(a.severity)] || b.confidence - a.confidence).slice(0, CLASSIFY_MAX);
      const classified = await Promise.all(
        top.map(async (finding) => {
          const excerpt = await excerptOf(cwd, finding);
          const { verdict, answer, recordId } = await judgeCheck(decide, "finding_classify", { kind: "finding", finding, excerpt }, task.repoPath ?? null, decisions);
          const severity = (answer?.severity ?? null) as { choice?: unknown; confidence?: unknown } | null;
          const usable = (verdict === "proceed" || verdict === "flag") && typeof severity?.choice === "string";
          return {
            id: finding.id ?? "",
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
        else if (row.classified === severityOf(row.severity)) calibration.agree++;
        else calibration.disagree++;
      }
      return { classified, calibration };
    };

    // Step A: the review, before anything of the suite runs (when agents are on).
    let pack: StageResult | null = null;
    let reviewed: Finding[] = [];
    let classification: Record<string, unknown> = {};
    if (deps.runPack) {
      pack = await deps.runPack(context, { ...(state.radius.length ? { blastRadius: state.radius } : {}), ...(state.image ? { image: state.image } : {}) });
      if (signal.aborted) return aborted();
      // A deliberate escalation is the pack's own answer, verbatim: it has no findings to compute a verdict from.
      if (pack.outcome === "escalated") return { ...pack, detail: { ...pack.detail, step: "review" } };
      const answer = answerOf(pack.detail);
      // Each finding gets its id; the same finding raised twice is one, at the highest level it was raised at. A finding from before v2.2 reads the same.
      reviewed = mergeDuplicateFindings(((Array.isArray(answer?.findings) ? answer.findings : pack.findings ?? []) as Finding[]).map(normaliseFinding));
      classification = await classify(reviewed);
      if (pack.outcome === "fail") return { ...pack, detail: { ...pack.detail, step: "review", ...classification } };
      const standing = assemble(pack, reviewed, classification);
      const blockers = standing.outcome === "fail" ? 1 : 0;
      if (verifySteps({ env: "matched", review: "done", blockers, checks: null }) === "fail") return standing;
    }

    const log: string[] = [];
    /** What each check ran and printed, for asking the base about the ones that fail. */
    const attempts = new Map<string, { argv: string[]; secrets: string[]; text: string; timedOut: boolean }>();
    const deadline = Date.now() + CHECKS_TIMEOUT_MS;
    // The repo's services start once for every check, not once per check, and come down however the loop ends.
    let pass: Awaited<ReturnType<typeof openChecksSession<typeof checkExec>>>;
    try {
      pass = await openChecksSession(checkExec, { cwd, ...(task.repoPath ? { repoPath: task.repoPath } : {}), services: commands.length > 0 ? services : {} });
    } catch (error) {
      const escalated = escalationOf(error);
      if (escalated) return escalated;
      throw error;
    }
    try {
      for (const { name, cmd, argv, secrets: declaredSecrets } of commands) {
        const remaining = deadline - Date.now();
        let result: ExecResult;
        let timedOut = false;
        if (remaining <= 0) {
          result = { code: 1, stdout: "", stderr: "skipped: the 30 minute checks budget ran out" };
          timedOut = true;
        } else {
          try {
            result = await pass.exec(argv[0]!, argv.slice(1), {
              cwd,
              signal,
              timeoutMs: remaining,
              env: { ...process.env, ...identityEnv, HARDNESS_STAGE: "verifying" },
              services,
              ...(task.repoPath ? { repoPath: task.repoPath } : {}),
              ...(declaredSecrets && declaredSecrets.length > 0 ? { secrets: declaredSecrets } : {}),
              ...(state.image ? { image: state.image } : {}),
            });
          } catch (error) {
            const escalated = escalationOf(error);
            if (escalated) return escalated;
            throw error;
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
        attempts.set(name, { argv, secrets: declaredSecrets ?? [], text, timedOut });
      }
    } finally {
      await pass.close();
    }
    reports.push(...skipped);
    // No test command (a docs, shell or markdown-only repo): the pack still proves each
    // scenario by direct check, so the stage goes on with a note instead of failing here.
    if (noTests) reports.push({ check: "none", note: "no test command detected; verifying proves the scenarios by direct check" });
    const runDir = join(deps.stateDir, "runs", context.runId);
    await mkdir(runDir, { recursive: true });
    const transcriptPath = join(runDir, "checks.log");
    await writeFile(transcriptPath, log.join("\n") || "no checks detected\n");

    let failed = reports.filter((r) => r.ok === false);
    // A failing check is asked again on the base. What fails there too is not the change's: it is the environment's (a service the container
    // lacks, the user it runs as) or the base's own. Only what passes on the base and fails here goes back to Build.
    const redOnBase: Array<{ name: string; tests: string[] }> = [];
    const baseline = deps.baseline;
    let baseSha: string | null = null;
    if (failed.length > 0 && baseline && task.repoPath && task.branch) {
      const base = await (baseline.base ?? branchBase)(cwd, task.repoPath).catch(() => null);
      if (base && SHA.test(base)) {
        baseSha = base;
        const cache = baseline.cache ?? baseCache;
        let clone: { path: string } | null = null;
        try {
          for (const r of failed) {
            const attempt = attempts.get(r.name ?? "");
            if (!attempt || attempt.timedOut) continue;
            const files = failingTestFiles(attempt.text);
            const narrowed = narrowedArgv(attempt.argv, files);
            const key = [base, state.image ?? "", r.name, narrowed ? "files" : "whole", files.join(",")].join("\0");
            let answer = cache.get(key);
            if (!stillFresh(answer)) {
              answer = undefined;
              const started = Date.now();
              let ran: ExecResult;
              try {
                clone ??= await baseline.clone(cwd, task.branch, `${context.runId}-base`, base);
                const argv = narrowed ?? attempt.argv;
                ran = await checkExec(argv[0]!, argv.slice(1), {
                  cwd: clone.path,
                  signal,
                  timeoutMs: BASE_CHECK_TIMEOUT_MS,
                  env: { ...process.env, ...identityEnv, HARDNESS_STAGE: "verifying" },
                  services,
                  repoPath: task.repoPath,
                  ...(attempt.secrets.length > 0 ? { secrets: attempt.secrets } : {}),
                  ...(state.image ? { image: state.image } : {}),
                });
              } catch {
                // The base could not be asked (no clone, no sandbox): the answer is unknown, so the check stays the change's.
                if (signal.aborted) return aborted();
                continue;
              }
              if (signal.aborted) return aborted();
              // A run that timed out or could not start says nothing. A run that fails must name every file the change failed on: a file the card added is not on the base.
              if (ran.code === 127 || (ran.code !== 0 && Date.now() - started >= BASE_CHECK_TIMEOUT_MS)) continue;
              const named = failingTestFiles(`${ran.stdout}\n${ran.stderr}`);
              answer = { red: ran.code !== 0 && files.every((f) => named.includes(f)), at: Date.now() };
              remember(cache, key, answer);
            }
            if (answer.red) redOnBase.push({ name: r.name ?? "", tests: files });
          }
        } finally {
          if (clone) await baseline.remove(clone.path).catch(() => {});
        }
        failed = failed.filter((r) => !redOnBase.some((red) => red.name === r.name));
      }
    }
    if (redOnBase.length > 0 && failed.length === 0) {
      const names = redOnBase.map((r) => r.name).join(", ");
      const tests = [...new Set(redOnBase.flatMap((r) => r.tests))];
      const gist = failureGist(attempts.get(redOnBase[0]!.name)?.text ?? "", 200);
      const one = redOnBase.length === 1;
      return {
        outcome: "escalated",
        detail: {
          escalation: "env_broken",
          envBroken: true,
          step: "checks",
          red_on_base: true,
          base: baseSha,
          tests,
          reason: `${names} ${one ? "fails" : "fail"} on the base commit ${baseSha!.slice(0, 7)} too, so this change did not cause ${one ? "it" : "them"} (${tests.slice(0, 5).join(", ") || gist})`,
          failed: redOnBase,
          checks: reports,
          options: ["fix the environment (a service, a tool, the user the checks run as) or the base, then resume"],
        },
        run: { transcriptPath },
      };
    }
    if (failed.length > 0) {
      const checkFindings: Finding[] = failed.map((r) => ({
        path: "",
        line: 0,
        start_line: null,
        severity: "test",
        category: "tests",
        title: `${r.name} failed`,
        body: r.tail ?? "",
        suggestion_code: null,
        confidence: 1,
      }));
      const findings = [...reviewed, ...checkFindings];
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
          ...(redOnBase.length > 0 ? { redOnBase, base: baseSha } : {}),
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
    }
    // One finding when the patch's coverage is under the repository's bar (`verify.coverage_drop_max`), naming the files.
    const dropped = coverage ? coverageFinding(coverage, coverageDropMax) : null;
    if (dropped) coverageFindings.push(dropped);
    // The repository's own mutation command (from its luna.yaml, never from text a model wrote), run in the sandbox after the checks; its output is data, read for one score line.
    let mutationDetail: Record<string, unknown> = {};
    if (mutationConfig.command) {
      let ran: ExecResult;
      try {
        // As every check: the card's repository names its image, its list and its install; nothing runs on the machine's bare defaults.
        ran = await checkExec("sh", ["-c", mutationConfig.command], { cwd, signal, timeoutMs: Math.max(deadline - Date.now(), MINUTE), env: { ...process.env, ...identityEnv, HARDNESS_STAGE: "verifying" }, services, ...(task.repoPath ? { repoPath: task.repoPath } : {}), ...(state.image ? { image: state.image } : {}) });
      } catch (error) {
        const escalated = escalationOf(error);
        if (escalated) return escalated;
        throw error;
      }
      for (const payload of blockedPayloads((ran as { blocked?: Parameters<typeof blockedPayloads>[0] }).blocked, "check")) await Promise.resolve(context.emit?.("sandbox.egress_blocked", payload)).catch(() => {});
      if (signal.aborted) return aborted();
      // A run that failed has no score to trust, whatever it printed.
      const score = ran.code === 0 ? parseMutationScore(`${ran.stdout}\n${ran.stderr}`) : null;
      if (score === null) reports.push({ name: "mutation", note: "the mutation run printed no score" });
      else {
        mutationDetail = { mutation: { score, min: mutationConfig.min_score } };
        const low = mutationFinding(score, mutationConfig.min_score);
        if (low) coverageFindings.push(low);
      }
    }
    const coverageDetail = { ...(coverage ? { coverage } : {}), ...mutationDetail };

    // The review already ran (when agents are on) and no blocker stands: the report is its result with the suite's.
    const noTestsNote = noTests ? { note: "no test command detected; verifying proves the scenarios by direct check" } : {};
    if (!pack) {
      return { outcome: "pass", detail: { step: "checks", note: "review: skipped (agents off)", checks: reports, ...coverageDetail }, ...(coverageFindings.length > 0 ? { findings: coverageFindings } : {}), run: { transcriptPath } };
    }
    return assemble(pack, [...reviewed, ...coverageFindings], { checks: reports, ...coverageDetail, ...classification, ...noTestsNote });
  };
  /** One should_fix finding when the counted diff is over `size.hard_limit_loc`, unless an approved plan gate carries `keepWhole` (a person's recorded override). */
  const sizeFinding = async (context: StageContext, worktreePath: string | null | undefined, repoPath: string | null): Promise<Finding | null> => {
    if (!worktreePath) return null;
    const kept = context.approvals.some((a) => a.kind === "awaiting_approval" && a.decision === "approved" && (a.response as { keepWhole?: unknown } | null)?.keepWhole === true);
    if (kept) return null;
    const limit = ((await deps.policy?.(repoPath))?.size ?? FACTORY_DEFAULTS.size).hard_limit_loc;
    const counted = await diffStat(worktreePath, repoPath).catch(() => null);
    if (!counted || counted.added + counted.removed <= limit) return null;
    return { path: "", line: 0, start_line: null, severity: "should_fix", category: "size", title: `the change is ${counted.added + counted.removed} lines, over the limit of ${limit}`, body: `${counted.added} lines added and ${counted.removed} removed; the limit is ${limit}. A change this size is hard to review as one pull request.`, suggestion_code: null, confidence: 1 };
  };
  return async (context) => {
    const state: { radius: string[]; image?: string } = { radius: [] };
    const { task } = context;
    // The repository's image is chosen once here: the environment compared below, the checks and the review run in this one, so what is recorded
    // is what ran even when a floating base moves meanwhile. One that cannot be built is an environment problem with the reason.
    if (deps.imageOf && task.repoPath) {
      try {
        state.image = await deps.imageOf(task.repoPath, context.signal);
      } catch (error) {
        if (!(error instanceof RepoImageError)) throw error;
        return { outcome: "escalated", detail: { escalation: "env_broken", envBroken: true, step: "image", reason: `the repository's image could not be built: ${error.reason}`, options: ["fix sandbox.image.base in luna.yaml, or remove it to use the machine's image, then resume"] } };
      }
    }
    const fresh = deps.fresh && task.worktreePath && task.branch ? await deps.fresh.make(task.worktreePath, task.branch, context.runId) : null;
    // Whatever the stage reads and runs is the fresh clone's; the card's folder is only touched to take a fast-forward back.
    const inFresh: StageContext = fresh ? { ...context, task: { ...task, worktreePath: fresh.path } } : context;
    // The environment Verify has, against the one Build recorded: a lockfile that differs at the same commit is a blocker. A different image is a note.
    let envReproduction: string | null = null;
    let envFinding: Finding | null = null;
    if (fresh && deps.buildEnv && deps.envOf) {
      const recorded = await deps.buildEnv(task.id);
      if (recorded) {
        const compared = compareEnv(recorded, await deps.envOf(fresh.path, fresh.commit, task.repoPath ?? undefined, state.image));
        // An image-only difference is a note on the report, not a failure: see compareEnv.
        envReproduction = compared.matched ? (compared.notes.length > 0 ? compared.notes.join("; ") : "matched") : compared.differences.join("; ");
        if (!compared.matched) {
          envFinding = { path: "", line: 0, start_line: null, severity: "blocker", category: "env", title: "the environment Verify has is not the one Build ran in", body: compared.differences.join("\n"), suggestion_code: null, confidence: 1 };
        }
      }
    }
    let result = verifySteps({ env: envFinding ? "mismatch" : "matched", review: null, blockers: 0, checks: null }) === "fail" && envFinding
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
    // The counted size is a finding, not a gate: a change that grew past the hard limit is said on the report and the PR, where its reviewer reads it.
    const grown = result.outcome === "pass" ? await sizeFinding(context, task.worktreePath, task.repoPath) : null;
    if (grown) result = { ...result, findings: [...(result.findings ?? []), grown], detail: { ...result.detail, ...(Array.isArray(result.detail?.findings) ? { findings: [...(result.detail!.findings as unknown[]), grown] } : {}) } };
    return state.radius.length > 0 ? { ...result, detail: { ...result.detail, blastRadius: state.radius } } : result;
  };
}
