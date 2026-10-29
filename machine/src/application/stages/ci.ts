// The ci_watch stage: poll the PR's checks until they settle. Green passes; red goes to the
// ci_watch pack, whose verdict decides: fixable fails (the loop hands its findings to
// implementing), flake re-runs the failed workflow once, infra and needs_debug escalate to a
// human with the pack's reason. The pack runs in a sandbox with no GitHub credential, so the
// host fetches the PR, the checks and the failed run's log and hands them over as context.
import type { CiContext, Finding } from "@hardness/contracts";

import { originSlugOf } from "../../adapters/git/worktree.ts";
import { exec } from "../../adapters/process/exec.ts";
import { type Check, type GitHub, messageOf } from "../github.ts";
import type { StageContext, StageResult, StageRunner } from "../ports.ts";

const MINUTE = 60_000;
const RERUN_WAIT_MS = 15 * MINUTE;
/** How long a push may take to show the checks the commit before it had: a workflow run is
 *  created a few seconds after the push, and until then only the fast external checks exist. */
const NEW_RUN_GRACE_MS = 3 * MINUTE;
/** The pack reads a log tail, not a whole run: the end is where the failure is. */
const LOG_TAIL_CHARS = 20_000;

export interface CiDeps {
  github: GitHub;
  /** Runs the ci_watch pack with what the host fetched about the red run. */
  runPack: (context: StageContext, ci: CiContext) => Promise<StageResult>;
  /** The `owner/name` of a worktree; tests inject one. */
  slugOf?: (cwd: string) => Promise<string | null>;
  /** The commit before the worktree's HEAD, whose checks the new head should repeat; tests inject one. */
  parentRef?: (cwd: string) => Promise<string | null>;
  /** How long to wait for those checks to appear on the new head. */
  graceMs?: number;
  pollMs?: number;
  maxWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const PENDING = new Set(["PENDING", "QUEUED", "IN_PROGRESS", "WAITING", "REQUESTED", "EXPECTED"]);
const FAILED = new Set(["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "STARTUP_FAILURE", "ACTION_REQUIRED", "STALE"]);

const parentOf = async (cwd: string): Promise<string | null> => {
  const parent = await exec("git", ["-C", cwd, "rev-parse", "--verify", "-q", "HEAD~1"]).catch(() => null);
  return parent && parent.code === 0 && parent.stdout.trim() ? parent.stdout.trim() : null;
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;

type Settled = { kind: "settled"; checks: Check[] } | { kind: "timeout" } | { kind: "aborted" } | { kind: "error"; error: string };

export function ciWatchRunner(deps: CiDeps): StageRunner {
  const pollMs = deps.pollMs ?? 30_000;
  const maxWaitMs = deps.maxWaitMs ?? 45 * MINUTE;
  const sleep = deps.sleep ?? defaultSleep;
  const slugOf = deps.slugOf ?? originSlugOf;
  const parentRef = deps.parentRef ?? parentOf;
  const graceMs = deps.graceMs ?? NEW_RUN_GRACE_MS;

  return async (context) => {
    const { task, signal } = context;
    if (!task.branch || !task.worktreePath) {
      return { outcome: "fail", detail: { error: "no branch to watch; the implementer never ran for real" } };
    }
    const branch = task.branch;
    const origin = await slugOf(task.worktreePath);
    if (!origin) return { outcome: "fail", detail: { error: "the worktree's origin is not a GitHub repository" } };
    const slug: string = origin;

    /** The check names the commit before HEAD had: after a fix is pushed, the new head must
     *  show them again before "nothing pending, nothing red" means anything. */
    let expected: Promise<string[]> | null = null;
    const expectedNames = () =>
      (expected ??= (async () => {
        const parent = await parentRef(task.worktreePath!).catch(() => null);
        if (!parent) return [];
        const before = await deps.github.prChecks(slug, parent).catch(() => [] as Check[]);
        return [...new Set(before.map((c) => c.name))];
      })());
    const graceEnds = Date.now() + graceMs;

    async function settle(waitMs: number): Promise<Settled> {
      const deadline = Date.now() + waitMs;
      for (;;) {
        if (signal.aborted) return { kind: "aborted" };
        let checks: Check[];
        try {
          checks = await deps.github.prChecks(slug, branch);
        } catch (error) {
          return { kind: "error", error: messageOf(error) };
        }
        if (!checks.some((c) => PENDING.has(String(c.state).toUpperCase()))) {
          const have = new Set(checks.map((c) => c.name));
          const missing = Date.now() < graceEnds && (await expectedNames()).some((name) => !have.has(name));
          if (!missing) return { kind: "settled", checks };
        }
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
    const runIdOf = (check: Check) => /\/actions\/runs\/(\d+)/.exec(check.link ?? "")?.[1];

    /** What the pack cannot fetch itself: the PR, every check, and the failed runs' log tail. */
    async function gather(checks: Check[], failed: Check[]): Promise<CiContext> {
      const pr = await deps.github.findPr(slug, branch).catch(() => null);
      const runIds = [...new Set(failed.map(runIdOf).filter((id): id is string => Boolean(id)))];
      const logs: string[] = [];
      for (const id of runIds) {
        logs.push(await deps.github.failedRunLog(slug, id).catch((error: unknown) => `(the log of run ${id} could not be read: ${messageOf(error)})`));
      }
      const joined = logs.join("\n");
      return {
        pr: pr ? { number: pr.number, url: pr.url } : null,
        checks: checks.map((c) => ({ name: c.name, state: c.state, url: c.link ?? null })),
        logs: joined ? joined.slice(-LOG_TAIL_CHARS) : null,
      };
    }

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
    const pack = await deps.runPack(context, await gather(checks, failed));
    if (pack.outcome === "fail" || pack.outcome === "escalated") {
      return { ...pack, detail: { ...pack.detail, step: "triage", checks } };
    }
    const answer = asRecord(pack.detail?.answer);
    const verdict = String(answer?.verdict ?? "fixable");
    const summary = typeof answer?.summary === "string" ? answer.summary : String(pack.detail?.summary ?? "");
    const findings = (Array.isArray(answer?.findings) ? answer.findings : pack.findings ?? []) as Finding[];
    const base = { ...pack, run: pack.run };
    const fixable = (note?: string): StageResult => ({
      ...base,
      outcome: "fail",
      detail: { step: "checks", verdict: "fixable", summary, findings, checks, ...(note ? { note } : {}) },
      findings,
    });

    if (verdict === "green") return { ...base, outcome: "pass", detail: { step: "checks", verdict, summary, checks } };
    if (verdict === "infra" || verdict === "needs_debug") {
      // Nothing implementing can fix: a human decides, with the pack's reason in front of them.
      const reason = typeof answer?.reason === "string" && answer.reason ? answer.reason : summary;
      const options = Array.isArray(answer?.options) ? answer.options.filter((o): o is string => typeof o === "string") : [];
      return { ...base, outcome: "escalated", detail: { step: "checks", verdict, summary, reason, options, findings, checks }, findings };
    }
    if (verdict !== "flake") return fixable();

    // Flake: one re-run of the failed workflow, then a second look.
    const runId = failed.map(runIdOf).find(Boolean);
    if (!runId) return fixable("flake verdict, but no workflow run id to re-run");
    try {
      await deps.github.rerunFailedJobs(slug, runId);
    } catch (error) {
      return fixable(`flake verdict, but the re-run failed: ${messageOf(error)}`);
    }
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
