// The verifying stage: run the project's own checks in the task worktree, and only when they
// are green hand the change to the verifying review pack. A red check fails the stage with
// its output as findings, so the next implementing attempt sees what broke.
import type { Finding } from "@hardness/contracts";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ExecResult } from "../../adapters/process/exec.ts";
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
    options: { env?: NodeJS.ProcessEnv; cwd?: string; signal?: AbortSignal; timeoutMs?: number },
  ) => Promise<ExecResult>;
  /** Runs the verifying review pack; null when agents are off, which skips the review. */
  runPack: ((context: StageContext) => Promise<StageResult>) | null;
  stateDir: string;
  detect?: (worktreePath: string) => Promise<DetectedChecks>;
}

interface CheckReport {
  check?: "none";
  name?: string;
  cmd?: string;
  ok?: boolean;
  tail?: string;
  note?: string;
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
  return async (context) => {
    const { task, signal } = context;
    // No worktree means implementing was stubbed (agents off): behave like the stub, not an escalation.
    if (!task.worktreePath) return { outcome: "pass", detail: { note: "no worktree; implementer was stubbed" } };
    const cwd = task.worktreePath;
    const aborted = (): StageResult => ({ outcome: "fail", detail: { error: "aborted" } });
    if (signal.aborted) return aborted();

    // Step A: the project's own checks.
    const found = await detect(cwd);
    const commands = CHECK_NAMES.flatMap((name) => (found[name] ? [{ name, argv: found[name]! }] : []));
    const reports: CheckReport[] = [];
    const log: string[] = [];
    const deadline = Date.now() + CHECKS_TIMEOUT_MS;
    for (const { name, argv } of commands) {
      const cmd = argv.join(" ");
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
          env: { ...process.env, HARDNESS_STAGE: "verifying" },
        });
        timedOut = result.code !== 0 && Date.now() >= deadline;
      }
      if (signal.aborted) return aborted();
      const text = `${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}`;
      const tail = tailOf(timedOut ? `${text}\ntimed out: the 30 minute checks budget ran out` : text);
      log.push(`$ ${cmd}\n(exit ${result.code})\n${text}\n`);
      reports.push({ name, cmd, ok: result.code === 0, tail });
    }
    // No test command (a docs, shell or markdown-only repo): the pack still proves each
    // scenario by direct check, so the stage goes on with a note instead of failing here.
    const noTests = !found.test;
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
