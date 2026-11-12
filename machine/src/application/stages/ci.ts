// The ci_watch stage: poll the PR's checks until they settle. Green passes; red goes to the
// ci_watch pack, whose verdict decides: fixable fails (the loop hands its findings to
// implementing), flake and infra re-run the failed workflow once (infra escalates if it stays red), needs_debug escalates to a
// human with the pack's reason. The pack runs in a sandbox with no GitHub credential, so the
// host fetches the PR, the checks and the failed run's log and hands them over as context.
import type { CiContext, DecisionOverrides, Finding } from "@hardness/contracts";

import { at } from "../../adapters/git/machine-repo.ts";
import { HOST_GIT, type GitExec, type RebaseResult, isBranchName, originSlugOf, rebaseOntoDefault, stackOf } from "../../adapters/git/worktree.ts";
import { exec } from "../../adapters/process/exec.ts";
import { safe } from "../../domain/evidence-markdown.ts";
import { type Check, type GitHub, messageOf } from "../github.ts";
import { alreadyMerged } from "./already-merged.ts";
import type { StageContext, StageResult, StageRunner } from "../ports.ts";
import { type CiFact, type TruthSink, ciClassTruth } from "../decision-truth.ts";
import { type Decide, judgeCheck } from "./check-decide.ts";
import { headSha, parentWinsFor, pushBranch, restoreHead } from "./deliver.ts";
import type { MergeInput, MergeOutcome } from "./ship-merge.ts";

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
  /** Runs git for the rebase and its push (default: the real one); tests inject a recorder. */
  exec?: GitExec;
  /** Rebases the worktree onto the default branch (default: `rebaseOntoDefault`); tests inject a fake. */
  rebase?: (exec: GitExec, worktreePath: string, repoPath: string) => Promise<RebaseResult>;
  /** Resolves a conflict the rebase could not (`mergeRound`: the addressing pack resolves the files, the project's checks prove the result, the merge is pushed). Absent, a conflict asks a person. */
  resolveConflicts?: (context: StageContext, input: MergeInput) => Promise<MergeOutcome>;
  /** Runs ci_failure_class on a failing job and its log tail; null (or absent) leaves the class to the investigator, as before. Read at call time. */
  decide?: Decide | null;
  /** Where a fact that settles the class is written (`ci_failure_class`'s truth); absent, nothing is learned. */
  truth?: TruthSink;
  /** The last red this card's CI stage judged: its record and the failing job; a green after a Build fix confirms it was a real failure. */
  lastRed?: (taskId: string) => Promise<{ recordId: string; job: string } | null>;
  /** The repository's `verify.ci_flaky_reruns` and `verify.auto_rebase`, and its decision overrides; one re-run and one rebase when absent. */
  policy?: (repoPath: string | null) => Promise<{ reruns: number; autoRebase: number; decisions?: Record<string, DecisionOverrides> }>;
  pollMs?: number;
  maxWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const PENDING = new Set(["PENDING", "QUEUED", "IN_PROGRESS", "WAITING", "REQUESTED", "EXPECTED"]);
const FAILED = new Set(["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "STARTUP_FAILURE", "ACTION_REQUIRED", "STALE"]);

const parentOf = async (cwd: string): Promise<string | null> => {
  const parent = await exec("git", [...HOST_GIT, ...at(cwd), "rev-parse", "--verify", "-q", "HEAD~1"]).catch(() => null);
  return parent && parent.code === 0 && parent.stdout.trim() ? parent.stdout.trim() : null;
};

/** The checks that ended red. */
export const failedChecks = (checks: Check[]): Check[] => checks.filter((c) => FAILED.has(String(c.state).toUpperCase()));
/** The workflow run a check belongs to, from its link. */
export const ciRunIdOf = (check: Check): string | undefined => /\/actions\/runs\/(\d+)/.exec(check.link ?? "")?.[1];

/** What the ci_watch pack cannot fetch itself (the sandbox has no GitHub credential): the PR, every check, and the failed runs' log tail. */
export async function ciContextOf(github: GitHub, slug: string, branch: string, checks: Check[], failed: Check[]): Promise<CiContext> {
  const pr = await github.findPr(slug, branch).catch(() => null);
  const runIds = [...new Set(failed.map(ciRunIdOf).filter((id): id is string => Boolean(id)))];
  const logs: string[] = [];
  for (const id of runIds) {
    logs.push(await github.failedRunLog(slug, id).catch((error: unknown) => `(the log of run ${id} could not be read: ${messageOf(error)})`));
  }
  const joined = logs.join("\n");
  return {
    pr: pr ? { number: pr.number, url: pr.url } : null,
    checks: checks.map((c) => ({ name: c.name, state: c.state, url: c.link ?? null })),
    logs: joined ? joined.slice(-LOG_TAIL_CHARS) : null,
  };
}

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
  const run: GitExec = deps.exec ?? exec;

  return async (context) => {
    const { task, signal } = context;
    if (!task.branch || !task.worktreePath) {
      return { outcome: "fail", detail: { error: "no branch to watch; the implementer never ran for real" } };
    }
    const branch = task.branch;
    const origin = await slugOf(task.worktreePath);
    if (!origin) return { outcome: "fail", detail: { error: "the worktree's origin is not a GitHub repository" } };
    const slug: string = origin;
    // The card's own PR may have merged while the card was outside the ship watch: it shipped, and its checks are nobody's to watch.
    if (context.recordedPrs?.length) {
      const shipped = await alreadyMerged(deps.github, slug, context.recordedPrs, () => deps.github.defaultBranch(slug));
      if (shipped) return shipped;
    }
    // The default branch is GitHub's answer for the slug (as in Deliver), never the branch the user's checkout is on; the parent wins the files the card's plan does not touch.
    const rebase = deps.rebase ?? ((r: GitExec, worktree: string, repo: string) => rebaseOntoDefault(r, worktree, repo, () => deps.github.defaultBranch(slug).catch(() => null), parentWinsFor(context)));

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
    let graceEnds = Date.now() + graceMs;

    /** Polls until nothing is pending. After a re-run, `before` (the checks as they stood when it was asked) must also be seen through: every
     *  check of it listed again, and none still red on its old link (the re-run's job has a new one), since GitHub first drops the re-run
     *  jobs from the list and may still show the old red for a moment; reading either as settled would call the re-run green, or red, unseen. */
    async function settle(waitMs: number, before?: readonly Check[]): Promise<Settled> {
      const deadline = Date.now() + waitMs;
      const wasRed = before ? failedOf([...before]) : [];
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
          const rerunUnseen = before
            ? before.some((b) => !have.has(b.name)) || failedOf(checks).some((c) => wasRed.some((b) => b.name === c.name && b.link === c.link))
            : false;
          if (!missing && !rerunUnseen) return { kind: "settled", checks };
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
    const failedOf = failedChecks;
    const runIdOf = ciRunIdOf;

    const gather = (checks: Check[], failed: Check[]) => ciContextOf(deps.github, slug, branch, checks, failed);

    const first = await settle(maxWaitMs);
    const early = stopped(first);
    if (early) return early;
    let checks = (first as { checks: Check[] }).checks;

    // A conflict with the base: GitHub runs no CI on it. Rebase the branch once, push it back, watch again.
    const conflicting = async (): Promise<boolean> => {
      const pr = await deps.github.findPr(slug, branch).catch(() => null);
      return pr ? (await deps.github.prFacts(slug, pr.number).catch(() => null))?.mergeable === "CONFLICTING" : false;
    };
    const stuck = (reason: string): StageResult => ({
      outcome: "escalated",
      detail: {
        step: "conflict",
        verdict: "conflict_unresolvable",
        reason,
        options: ["rebase the branch by hand and approve", "merge the default branch into the branch and approve"],
        escalation: "other",
        checks,
      },
    });
    /** Tells the decision log what a later fact says the class should have been; never throws. */
    const teach = async (recordId: string | undefined, fact: CiFact): Promise<void> => {
      if (!recordId || !deps.truth) return;
      const derived = ciClassTruth(fact);
      await deps.truth.learned({ pack: "ci_failure_class", recordId, label: derived.label, kind: derived.kind, source: derived.source, taskId: task.id }).catch(() => {});
    };
    // A rerun or a rebase in this round: a green after one of them is not a Build fix's doing.
    let acted = false;

    let rebased = false;
    /** The checks as they stand: `judge`'s own parameter shadows the variable a rebase refreshes. */
    const current = (): Check[] => checks;
    /**
     * A rebase that stopped on conflicts is answered with the merge round Deliver and the ship watch use (`mergeRound`): the base is merged on a
     * fresh clone, the addressing pack resolves the files, the project's checks prove it and it is pushed. The base is the parent's branch for a
     * stacked card, else GitHub's default branch. "merged" when it landed, its reason when it did not, null when it cannot run (no round wired, no PR, no tip).
     */
    const mergeInstead = async (): Promise<"merged" | { failed: string } | null> => {
      if (!deps.resolveConflicts) return null;
      const pr = await deps.github.findPr(slug, branch).catch(() => null);
      const baseName = (await stackOf(task.worktreePath!)).branch ?? (await deps.github.defaultBranch(slug).catch(() => null));
      if (!pr || !baseName || !isBranchName(baseName)) return null;
      const tip = (await run("git", [...HOST_GIT, ...at(task.worktreePath!), "rev-parse", "--verify", `refs/remotes/origin/${baseName}^{commit}`])).stdout.trim();
      if (!/^[0-9a-f]{40,64}$/.test(tip)) return null;
      const merged = await deps.resolveConflicts(context, { slug, number: pr.number, base: { sha: tip, name: baseName }, label: "ci", pack: null });
      return merged.ok ? "merged" : { failed: String(merged.result.detail?.reason ?? merged.result.detail?.error ?? "the merge did not land") };
    };
    /** Rebases the branch onto the default branch, pushes it back and watches the checks again: null when it went well, else the result to return. */
    const rebaseAndWatch = async (): Promise<StageResult | null> => {
      const repoPath = task.repoPath ?? task.worktreePath!;
      // The head the branch was pushed at: the lease for the forced push, and where the branch goes back to if that push fails.
      const before = await headSha(run, task.worktreePath!);
      const result = await rebase(run, task.worktreePath!, repoPath);
      let landed = false;
      if (!result.ok) {
        const said = result.conflicts.length > 0 ? `the default branch moved and the rebase stops on: ${result.conflicts.join(", ")}` : `the branch conflicts with the default branch and could not be rebased: ${result.error}`;
        const merged = result.conflicts.length > 0 ? await mergeInstead() : null;
        if (!merged) return stuck(said);
        if (merged !== "merged") return stuck(`${said}; merging instead did not resolve it: ${merged.failed}`);
        landed = true;
      }
      // A merge the round landed is already pushed (never forced) and descends from the PR's head.
      const pushError = landed ? null : await pushBranch(run, branch, task.worktreePath!, { force: true, ...(before ? { lease: before } : {}) });
      if (pushError) {
        // Left rewritten, the branch would be refused as a non-fast-forward by every later push.
        if (before) await restoreHead(run, task.worktreePath!, before);
        return { outcome: "fail", detail: { error: pushError } };
      }
      rebased = true;
      graceEnds = Date.now() + graceMs;
      expected = null;
      const again = await settle(maxWaitMs);
      const stoppedAfter = stopped(again);
      if (stoppedAfter) return stoppedAfter;
      checks = (again as { checks: Check[] }).checks;
      return null;
    };
    if (await conflicting()) {
      // Rebasing and force-pushing is the repository's to allow (`verify.auto_rebase`); off, a person does it.
      const allowed = deps.policy ? (await deps.policy(task.repoPath ?? null)).autoRebase >= 1 : true;
      if (!allowed) return stuck("the branch conflicts with the default branch and the repository does not allow an automatic rebase (verify.auto_rebase is 0)");
      const failedRebase = await rebaseAndWatch();
      if (failedRebase) return failedRebase;
      if (await conflicting()) return stuck("the branch still conflicts with the default branch after one rebase");
    }
    const outcome = await judge(checks);
    return rebased ? { ...outcome, detail: { ...outcome.detail, rebased: true } } : outcome;

    async function judge(checks: Check[]): Promise<StageResult> {
      if (checks.length === 0) {
        return { outcome: "pass", detail: { step: "checks", checks, note: "no CI checks are configured on this PR" } };
      }
      const failed = failedOf(checks);
      if (failed.length === 0) {
        // Green after a Build fix: the red the last round named was a real failure, if it was the same job.
        const before = acted || rebased || !deps.lastRed ? null : await deps.lastRed(task.id).catch(() => null);
        if (before) await teach(before.recordId, "fixed");
        return { outcome: "pass", detail: { step: "checks", checks } };
      }

      // Red: what kind of red is a typed decision on the failing job and its log; only a real failure asks the investigator for the fix.
      const ci = await gather(checks, failed);
      const settings = deps.policy ? await deps.policy(task.repoPath ?? null) : { reruns: 1, autoRebase: 1 };
      const decide = deps.decide ?? null;
      const asked = decide
        ? await judgeCheck(decide, "ci_failure_class", { kind: "ci", ci: { job: safe(failed[0]?.name ?? "").slice(0, 200), log: safe(ci.logs ?? "").slice(-4000) } }, task.repoPath ?? null, settings.decisions ?? {})
        : null;
      const choice = (asked?.answer?.class as { choice?: unknown } | undefined)?.choice;
      const kind = asked && (asked.verdict === "proceed" || asked.verdict === "flag") && (choice === "real" || choice === "flake" || choice === "infra" || choice === "drift") ? choice : null;
      const classFacts = asked?.recordId ? { classRecord: asked.recordId, classJob: safe(failed[0]?.name ?? "").slice(0, 200) } : {};
      const person = (reason: string, escalation: "flaky_tests" | "env_broken" | "other", options: string[]): StageResult => ({
        outcome: "escalated",
        detail: { step: "checks", verdict: kind === "flake" ? "flake" : "infra", class: kind, summary: reason, reason, options, checks, escalation, ...classFacts },
      });
      // An infrastructure failure (a registry's 504, a runner that died) is often gone a minute later: the failed jobs re-run once, as a flake's
      // do, and a person is asked only when they stay red. Nothing is taught: a green re-run after an outage does not make the outage a flake.
      if (kind === "infra") {
        const infraEscalation = (why: string) => person(`the failure is in the CI infrastructure or its environment, not in the change${why}`, "env_broken", ["fix the runner or the service, then re-run CI and approve", "re-run the failed jobs by hand"]);
        const runId = failed.map(runIdOf).find(Boolean);
        for (let round = 0; runId && round < settings.reruns; round++) {
          acted = true;
          const before = checks;
          try {
            await deps.github.rerunFailedJobs(slug, runId);
          } catch (error) {
            return infraEscalation(`, and the re-run could not start: ${messageOf(error)}`);
          }
          const next = await settle(RERUN_WAIT_MS, before);
          const stoppedNext = stopped(next);
          if (stoppedNext) return stoppedNext;
          checks = (next as { checks: Check[] }).checks;
          if (failedOf(checks).length === 0) return { outcome: "pass", detail: { step: "checks", verdict: "infra", class: "infra", checks, note: "infrastructure failure, re-run passed" } };
        }
        return infraEscalation(runId && settings.reruns > 0 ? `; it stayed red after ${settings.reruns} re-run${settings.reruns === 1 ? "" : "s"}` : "");
      }
      if (kind === "drift") {
        if (rebased || settings.autoRebase < 1) return person("the base branch moved under the change and the branch was not rebased automatically", "other", ["rebase the branch by hand and approve", "merge the default branch into the branch and approve"]);
        const failedRebase = await rebaseAndWatch();
        if (failedRebase) return failedRebase;
        acted = true;
        const after = await judge(current());
        // Green after nothing but the rebase: the base had moved.
        if (after.outcome === "pass") await teach(asked?.recordId, "rebased");
        return after;
      }
      if (kind === "flake") {
        const runId = failed.map(runIdOf).find(Boolean);
        for (let round = 0; runId && round < settings.reruns; round++) {
          acted = true;
          const before = checks;
          try {
            await deps.github.rerunFailedJobs(slug, runId);
          } catch (error) {
            return person(`a flaky failure, and the re-run could not start: ${messageOf(error)}`, "flaky_tests", ["re-run the failed jobs by hand and approve"]);
          }
          const next = await settle(RERUN_WAIT_MS, before);
          const stoppedNext = stopped(next);
          if (stoppedNext) return stoppedNext;
          checks = (next as { checks: Check[] }).checks;
          if (failedOf(checks).length === 0) {
            await teach(asked?.recordId, "rerun_passed");
            return { outcome: "pass", detail: { step: "checks", verdict: "flake", class: "flake", checks, note: "flake, re-run passed" } };
          }
        }
        if (runId && settings.reruns > 0) await teach(asked?.recordId, "rerun_red");
        return person(`a flaky failure that stayed red after ${settings.reruns} re-run${settings.reruns === 1 ? "" : "s"}`, "flaky_tests", ["look at the failing job's log and fix or quarantine the test, then approve", "re-run the failed jobs by hand"]);
      }
      const pack = await deps.runPack(context, ci);
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
        detail: { step: "checks", verdict: "fixable", summary, findings, checks, ...(kind ? { class: kind } : {}), ...classFacts, ...(note ? { note } : {}) },
        findings,
      });

      if (verdict === "green") return { ...base, outcome: "pass", detail: { step: "checks", verdict, summary, checks } };
      if (verdict === "infra" || verdict === "needs_debug" || verdict === "conflict_unresolvable") {
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
      const second = await settle(RERUN_WAIT_MS, checks);
      const stoppedAgain = stopped(second);
      if (stoppedAgain) return stoppedAgain;
      const after = (second as { checks: Check[] }).checks;
      if (failedOf(after).length === 0) {
        return { ...base, outcome: "pass", detail: { step: "checks", verdict, summary, checks: after, note: "flake, re-run passed" } };
      }
      return fixable("flake verdict, but it stayed red after one re-run");
    }
  };
}
