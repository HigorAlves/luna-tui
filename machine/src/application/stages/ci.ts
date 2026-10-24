// The ci_watch stage: poll the PR's checks until they settle. Green passes; red goes to the
// ci_watch pack, whose verdict decides: fixable fails (the loop hands its findings to
// implementing), flake re-runs the failed workflow once, infra and needs_debug fail with the
// pack's `requested` actions. The engine escalates after its usual three strikes, so an infra
// verdict costs up to three runs before the approval shows; accepted, the engine stays as is.
import type { Finding, RequestedAction } from "@hardness/contracts";

import { type ExecFn, prChecks, rerunWorkflow } from "../../adapters/github/gh.ts";
import type { StageContext, StageResult, StageRunner } from "../ports.ts";

const MINUTE = 60_000;
const RERUN_WAIT_MS = 15 * MINUTE;

export interface CiDeps {
  exec: ExecFn;
  /** Runs the ci_watch pack. */
  runPack: (context: StageContext) => Promise<StageResult>;
  pollMs?: number;
  maxWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

interface Check {
  name: string;
  state: string;
  link?: string;
}

const PENDING = new Set(["PENDING", "QUEUED", "IN_PROGRESS", "WAITING", "REQUESTED", "EXPECTED"]);
const FAILED = new Set(["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "STARTUP_FAILURE", "ACTION_REQUIRED", "STALE"]);

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;

type Settled = { kind: "settled"; checks: Check[] } | { kind: "timeout" } | { kind: "aborted" } | { kind: "error"; error: string };

export function ciWatchRunner(deps: CiDeps): StageRunner {
  const pollMs = deps.pollMs ?? 30_000;
  const maxWaitMs = deps.maxWaitMs ?? 45 * MINUTE;
  const sleep = deps.sleep ?? defaultSleep;

  return async (context) => {
    const { task, signal } = context;
    if (!task.branch || !task.worktreePath) {
      return { outcome: "fail", detail: { error: "no branch to watch; the implementer never ran for real" } };
    }
    const cwd = task.worktreePath;
    const branch = task.branch;

    async function settle(waitMs: number): Promise<Settled> {
      const deadline = Date.now() + waitMs;
      for (;;) {
        if (signal.aborted) return { kind: "aborted" };
        const polled = await prChecks({ exec: deps.exec }, branch, cwd, signal);
        let checks: Check[] = [];
        try {
          const parsed: unknown = JSON.parse(polled.stdout || "[]");
          if (Array.isArray(parsed)) checks = parsed as Check[];
        } catch {
          if (polled.code !== 0 && !/no checks/i.test(polled.stderr)) {
            return { kind: "error", error: `gh pr checks failed: ${(polled.stderr || polled.stdout).trim()}` };
          }
        }
        if (!checks.some((c) => PENDING.has(String(c.state).toUpperCase()))) return { kind: "settled", checks };
        if (Date.now() >= deadline) return { kind: "timeout" };
        await sleep(pollMs);
      }
    }

    const timedOut = (): StageResult => ({ outcome: "fail", detail: { error: "CI did not settle in 45m" } });
    const stopped = (s: Settled): StageResult | null =>
      s.kind === "aborted"
        ? { outcome: "fail", detail: { error: "aborted" } }
        : s.kind === "timeout"
          ? timedOut()
          : s.kind === "error"
            ? { outcome: "fail", detail: { error: s.error } }
            : null;
    const failedOf = (checks: Check[]) => checks.filter((c) => FAILED.has(String(c.state).toUpperCase()));

    const first = await settle(maxWaitMs);
    const early = stopped(first);
    if (early) return early;
    const checks = (first as { checks: Check[] }).checks;
    if (checks.length === 0) {
      return { outcome: "pass", detail: { step: "checks", checks, note: "no CI checks are configured on this PR" } };
    }
    const failed = failedOf(checks);
    if (failed.length === 0) return { outcome: "pass", detail: { step: "checks", checks } };

    // Red: ask the pack what kind of red.
    const pack = await deps.runPack(context);
    if (pack.outcome === "fail") return { ...pack, detail: { ...pack.detail, step: "triage", checks } };
    const answer = asRecord(pack.detail?.answer);
    const verdict = String(answer?.verdict ?? "fixable");
    const summary = typeof answer?.summary === "string" ? answer.summary : String(pack.detail?.summary ?? "");
    const findings = (Array.isArray(answer?.findings) ? answer.findings : pack.findings ?? []) as Finding[];
    const requested = (Array.isArray(answer?.requested) ? answer.requested : pack.requested ?? []) as RequestedAction[];
    const base = { ...pack, run: pack.run };
    const fixable = (note?: string): StageResult => ({
      ...base,
      outcome: "fail",
      detail: { step: "checks", verdict: "fixable", summary, findings, checks, ...(note ? { note } : {}) },
      findings,
    });

    if (verdict === "green") return { ...base, outcome: "pass", detail: { step: "checks", verdict, summary, checks } };
    if (verdict === "infra" || verdict === "needs_debug") {
      return {
        ...base,
        outcome: "fail",
        detail: { step: "checks", verdict, summary, requested, findings, checks },
        requested,
        findings,
      };
    }
    if (verdict !== "flake") return fixable();

    // Flake: one re-run of the failed workflow, then a second look.
    const runId = /\/actions\/runs\/(\d+)/.exec(failed.find((c) => c.link)?.link ?? "")?.[1];
    if (!runId) return fixable("flake verdict, but no workflow run id to re-run");
    const rerun = await rerunWorkflow({ exec: deps.exec }, runId, cwd, signal);
    if (rerun.code !== 0) return fixable(`flake verdict, but the re-run failed: ${rerun.stderr.trim()}`);
    const second = await settle(RERUN_WAIT_MS);
    const stoppedAgain = stopped(second);
    if (stoppedAgain) return stoppedAgain;
    const after = (second as { checks: Check[] }).checks;
    if (failedOf(after).length === 0) {
      return { ...base, outcome: "pass", detail: { step: "checks", verdict, summary, checks: after, note: "flake, re-run passed" } };
    }
    return fixable("flake verdict, but it stayed red after one re-run");
  };
}
