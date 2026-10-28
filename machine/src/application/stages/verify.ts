// The verifying stage: run the project's own checks in the task worktree, and only when they
// are green hand the change to the verifying review pack. A red check fails the stage with
// its output as findings, so the next implementing attempt sees what broke.
import type { CheckSpec, Finding, ServiceSpec } from "@hardness/contracts";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { changedPaths as hostChangedPaths, gitIdentity as hostGitIdentity } from "../../adapters/git/worktree.ts";
import type { ExecResult } from "../../adapters/process/exec.ts";
import { checkCommand, selectChecks, skippedReason } from "../../domain/checks.ts";
import { type DetectedChecks, detectChecks } from "../../domain/detect.ts";
import type { StageContext, StageResult, StageRunner } from "../ports.ts";

const MINUTE = 60_000;
export const CHECKS_TIMEOUT_MS = 30 * MINUTE;
const TAIL_LINES = 60;
const CHECK_NAMES = ["test", "lint", "typecheck"] as const;

export interface VerifyDeps {
  exec: (
    command: string,
    args: string[],
    options: { env?: NodeJS.ProcessEnv; cwd?: string; signal?: AbortSignal; timeoutMs?: number; services?: Record<string, ServiceSpec> },
  ) => Promise<ExecResult>;
  /** Runs the verifying review pack; null when agents are off, which skips the review. */
  runPack: ((context: StageContext) => Promise<StageResult>) | null;
  stateDir: string;
  detect?: (worktreePath: string) => Promise<DetectedChecks>;
  /** Who a check commits as: the identity git resolves for the repo. Null escalates. */
  gitIdentity?: (repoPath: string) => Promise<{ name: string; email: string } | null>;
  /** The repo's luna.yaml: its own checks (null means detect them from the tree) and the
   *  services to run beside each one. */
  policy?: (repoPath: string | null) => Promise<{ checks: CheckSpec[] | null; services: Record<string, ServiceSpec> }>;
  /** The files the branch changed, worktree-relative; null when unknown (then every check runs). */
  changedPaths?: (worktreePath: string, repoPath: string) => Promise<string[] | null>;
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

const tailOf = (text: string): string => text.trimEnd().split("\n").slice(-TAIL_LINES).join("\n");

/** The mechanical fail rule: a confident bug or security finding. */
export const verdictOf = (findings: Finding[]): "pass" | "fail" =>
  findings.some((f) => f.confidence >= 0.8 && (f.severity === "bug" || f.severity === "security")) ? "fail" : "pass";

const answerOf = (detail: Record<string, unknown> | undefined): Record<string, unknown> | undefined => {
  const answer = detail?.answer;
  return answer && typeof answer === "object" ? (answer as Record<string, unknown>) : undefined;
};

export function verifyRunner(deps: VerifyDeps): StageRunner {
  const detect = deps.detect ?? detectChecks;
  const resolveIdentity = deps.gitIdentity ?? hostGitIdentity;
  const repoPolicy = deps.policy ?? (async () => ({ checks: null, services: {} }));
  const changed = deps.changedPaths ?? hostChangedPaths;
  return async (context) => {
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
    const identityEnv = {
      GIT_AUTHOR_NAME: identity.name,
      GIT_AUTHOR_EMAIL: identity.email,
      GIT_COMMITTER_NAME: identity.name,
      GIT_COMMITTER_EMAIL: identity.email,
    };
    // Step A: the project's own checks: the luna.yaml list when the repo has one (those the
    // change calls for), else what the tree says.
    const { checks: declared, services } = await repoPolicy(task.repoPath ?? null);
    const reports: CheckReport[] = [];
    let commands: Array<{ name: string; cmd: string; argv: string[] }>;
    let noTests: boolean;
    const skipped: CheckReport[] = [];
    if (declared) {
      const selected = selectChecks(declared, task.repoPath ? await changed(cwd, task.repoPath) : null);
      commands = selected.map(checkCommand);
      for (const check of declared) if (!selected.includes(check)) skipped.push({ name: check.name, skipped: skippedReason(check) });
      noTests = declared.length === 0;
    } else {
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
        result = await deps.exec(argv[0]!, argv.slice(1), {
          cwd,
          signal,
          timeoutMs: remaining,
          env: { ...process.env, ...identityEnv, HARDNESS_STAGE: "verifying" },
          services,
        });
        timedOut = result.code !== 0 && Date.now() >= deadline;
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

    // Step B: the review pack, only when agents are on.
    const noTestsNote = noTests ? { note: "no test command detected; verifying proves the scenarios by direct check" } : {};
    if (!deps.runPack) {
      return { outcome: "pass", detail: { step: "checks", note: "review: skipped (agents off)", checks: reports }, run: { transcriptPath } };
    }
    const pack = await deps.runPack(context);
    // A plain failure or a deliberate escalation are both the pack's own answer, verbatim —
    // neither should fall into the verdict computation below (an escalation has no real
    // findings to compute one from, and would otherwise be miscounted as a pass).
    if (pack.outcome === "fail" || pack.outcome === "escalated") {
      return { ...pack, detail: { ...pack.detail, step: "review", checks: reports } };
    }
    const answer = answerOf(pack.detail);
    const findings = (Array.isArray(answer?.findings) ? answer.findings : pack.findings ?? []) as Finding[];
    const results = Array.isArray(answer?.results) ? answer.results : [];
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
        checks: reports,
        ...noTestsNote,
        ...(asked ? { note: "the reviewer asked a question; a reviewer should not, so the review counts as a pass" } : {}),
      },
      findings,
    };
  };
}
