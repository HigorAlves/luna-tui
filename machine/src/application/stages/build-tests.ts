// Build's tests step: before the implementer runs, a test writer makes one failing test per approved scenario, tagged `@scenario:<id>`.
// The machine checks the diff by script (`scenarioTags`), makes the commit itself, and only then runs the implementer. The feature route only.
import { type CheckContext, Plan, type PlanContext } from "@hardness/contracts";

import { approvedScenarios } from "../../domain/stage-input.ts";
import { safe } from "../../domain/evidence-markdown.ts";
import { isPlainRepoPath } from "@hardness/contracts";
import { type ScenarioTagFacts, scenarioTags } from "../../domain/scenario-tags.ts";
import type { StageContext, StageResult, StageRunner } from "../ports.ts";
import { voteRed } from "./red-vote.ts";
import type { SweepOutcome } from "./sweep.ts";

/** A tree the writer left, or a commit the step made earlier: what git says changed, and the diff. */
export interface TestsDiff {
  nameStatus: string;
  diff: string;
  /** The new mode of each path (`git diff --raw`): a symlink (120000) or a gitlink (160000) is never a test. */
  modes?: Record<string, string>;
  /** Per `.rs` file, the line ranges of its `#[cfg(test)]` modules in the new file: Rust's inline tests. */
  testRegions?: Record<string, Array<[number, number]>>;
}

export interface BuildTestsDeps {
  /** The implementer, handed the tests the step made (by scenario). */
  implement: (context: StageContext, extra: { scenarioTests?: { scenario: string; file: string }[]; /** Source files that hold Rust's inline tests, which the implementer may change. */ inlineTests?: string[]; sweepFailures?: { name: string; tail: string }[]; scopeBase?: string; /** Every path of the tests commit: none may change without a person. */ testsFiles?: string[] }) => Promise<StageResult>;
  /** The test writer, as a sub-run; a second round carries what the first left out as `plan.review`. */
  runWriter: (context: StageContext, extra: { plan?: PlanContext }) => Promise<StageResult>;
  /** The red_check decision for one scenario's test; `skipped` when it did not answer in time (it never blocks). `problems` are what a confident no said is wrong. */
  judgeRed: (check: CheckContext, repoPath: string | null) => Promise<{ verdict: string; problems: string[] }>;
  /** The source of the scenario's tagged test, read from the worktree, capped; null when it cannot be read. The judge reads it beside the writer's report. */
  readTest?: (worktree: string, file: string, scenario: string) => Promise<string | null>;
  /** Pushes the tests commit to the checkpoint ref before the implementer runs (a push that fails is a note, never a failure). */
  checkpoint: (context: StageContext, worktree: string, follows: "red" | "green") => Promise<void>;
  /** The regression sweep by script, after the implementer's last slice is green. */
  sweep: (context: StageContext) => Promise<SweepOutcome>;
  /** Build's budget now: whether it is spent and the minutes left, read before each fix run of a failed sweep. */
  /** The clock, for the step's shared deadline (tests inject one). */
  now?: () => number;
  budget?: (context: StageContext) => Promise<{ spent: boolean; minutesLeft: number } | undefined>;
  /** The repo's `holdout_cases`: the implementer must not see the scenarios, so no test is written for it to read. */
  holdout: (repoPath: string) => Promise<boolean>;
  git: {
    /** The worktree's HEAD now. */
    head: (worktree: string) => Promise<string>;
    /** Stages everything the writer left in the worktree and says what that adds to `base`, the commit the run started from. */
    pending: (worktree: string, base: string) => Promise<TestsDiff>;
    /** Commits what is staged; the sha. */
    commit: (worktree: string, subject: string, body: string) => Promise<string>;
    /** Puts the worktree back on `base`: whatever the writer left or committed is gone. */
    reset: (worktree: string, base: string) => Promise<void>;
    /** What the commit `sha` changed and its parent, when it is an ancestor of HEAD; null otherwise. The sha is the one the machine itself recorded, never one found by its subject. */
    readCommit: (worktree: string, sha: string) => Promise<(TestsDiff & { parent: string }) | null>;
    /** The branch the worktree is on now. */
    branch: (worktree: string) => Promise<string>;
  };
}

const MAX_NAMED = 10;
/** Implementer runs a failed sweep may cause: the sweep is not a way to loop for ever. */
const MAX_SWEEP_FIXES = 2;

type Usage = NonNullable<StageResult["usage"]>;

/** Two runs' usage added: turns and cost where both are known, tokens where either counted. */
function addUsage(a: StageResult["usage"], b: StageResult["usage"]): StageResult["usage"] {
  if (!a) return b;
  if (!b) return a;
  const sum = (x: number | null, y: number | null) => (x === null && y === null ? null : (x ?? 0) + (y ?? 0));
  const tokens = a.tokens || b.tokens ? { input: (a.tokens?.input ?? 0) + (b.tokens?.input ?? 0), output: (a.tokens?.output ?? 0) + (b.tokens?.output ?? 0), cached: (a.tokens?.cached ?? 0) + (b.tokens?.cached ?? 0) } : null;
  return { turns: sum(a.turns, b.turns), costUsd: sum(a.costUsd, b.costUsd), tokens } satisfies Usage;
}

/** What the diff check found wrong, as lines to send back or to say: ids and plain paths only. */
function problemsOf(facts: ScenarioTagFacts): string[] {
  const path = (p: string) => (isPlainRepoPath(p) ? safe(p).slice(0, 120) : "(a path that is not a plain repository path)");
  return [
    ...(facts.missing.length ? [`no test tagged @scenario:<id> for ${facts.missing.slice(0, MAX_NAMED).join(", ")}`] : []),
    ...(facts.ambiguous.length ? [`a test line carries several scenario ids; one @scenario:<id> per line: ${facts.ambiguous.slice(0, MAX_NAMED).map(path).join(", ")}`] : []),
    ...(facts.nonTest.length ? [`only test files and fixtures beside them may change; not ${facts.nonTest.slice(0, MAX_NAMED).map(path).join(", ")}`] : []),
    ...(facts.removed.length ? [`a test file was removed: ${facts.removed.slice(0, MAX_NAMED).map(path).join(", ")}`] : []),
  ];
}

const reviewContext = (review: string[]): PlanContext => ({ record: null, brief: "", criteria: [], assumptions: [], slices: [], review });

export function buildTestsStep(deps: BuildTestsDeps): StageRunner {
  return async (context) => {
    const { task } = context;
    // One absolute deadline for the whole step: the minutes the card had left when it began. Every sub-run (a writer round, the implementer, a sweep fix) is
    // handed what is left of that and of the budget the store counts now, whichever is smaller; none is handed more than remains.
    const began = (deps.now ?? Date.now)();
    const deadlineMinutes = context.budgetMinutes;
    const spentResult = (): StageResult => ({ outcome: "escalated", detail: { escalation: "other", reason: "Build's budget is spent: the card has no minutes left for the next run; a person decides", budgetSpent: true } });
    /** The context for the next sub-run with its minutes clamped, or null when the budget is spent. */
    const budgeted = async (): Promise<StageContext | null> => {
      const state = await deps.budget?.(context);
      const own = deadlineMinutes === undefined ? undefined : deadlineMinutes - ((deps.now ?? Date.now)() - began) / 60_000;
      if (state?.spent || (own !== undefined && own <= 0)) return null;
      const minutes = [state?.minutesLeft, own].filter((m): m is number => m !== undefined);
      return minutes.length > 0 ? { ...context, budgetMinutes: Math.min(...minutes) } : context;
    };
    /** The implementer, and after its last slice the regression sweep: a failing check sends it round again with the check's name and output. */
    const implementSwept = async (extra: Parameters<BuildTestsDeps["implement"]>[1]): Promise<StageResult> => {
      const first = await budgeted();
      if (!first) return spentResult();
      let result = await deps.implement(first, extra);
      let usage = result.usage;
      for (let fixes = 0; ; fixes++) {
        // A fix run that fails still returns what every run before it spent.
        if (result.outcome !== "pass") return { ...result, ...(usage ? { usage } : {}) };
        const sweep = await deps.sweep(context);
        const summary = { status: sweep.status, ran: sweep.ran, ...(sweep.note ? { note: sweep.note } : {}), ...(sweep.failed.length ? { failed: sweep.failed.map((f) => f.name) } : {}) };
        const done = (outcome: StageResult): StageResult => ({ ...outcome, ...(usage ? { usage } : {}), detail: { ...outcome.detail, sweep: summary } });
        if (sweep.aborted) return done({ outcome: "fail", detail: { error: "aborted" } });
        if (sweep.escalated) return done({ outcome: "escalated", detail: sweep.escalated });
        if (sweep.missingTool) return done({ outcome: "escalated", detail: { envBroken: true, reason: `\`${safe(sweep.missingTool.cmd).slice(0, 200)}\` cannot run: the runner image lacks the tool (${safe(sweep.missingTool.tail).slice(0, 200)})` } });
        if (sweep.status !== "failed") {
          // The build is green and swept: each scenario's test is green (the implementer runs the full suite before it commits a slice).
          for (const t of extra.scenarioTests ?? []) await context.emit?.("scenario.green", { scenario: t.scenario });
          return done(result);
        }
        const names = sweep.failed.map((f) => safe(f.name).slice(0, 60));
        await context.emit?.("build.sweep_failed", { checks: names });
        // The budget is read before each fix run, and the run gets the minutes that are left.
        const next = fixes >= MAX_SWEEP_FIXES ? null : await budgeted();
        if (!next) {
          return done({ outcome: "fail", detail: { error: `the regression sweep failed: ${names.join(", ")}`, sweepFailures: names } });
        }
        result = await deps.implement(next, { ...extra, sweepFailures: sweep.failed });
        usage = addUsage(usage, result.usage);
      }
    };
    const scenarios = approvedScenarios(context.approvals);
    if (task.route !== "feature") return deps.implement(context, {});
    if (!task.repoPath || scenarios.length === 0) return implementSwept({});

    /** What the writer's runs cost: added to the run the stage reports, so the budget counts them. */
    let writerUsage: StageResult["usage"];
    const withStep = (result: StageResult, testsStep: Record<string, unknown>): StageResult => {
      const usage = addUsage(writerUsage, result.usage);
      return { ...result, ...(usage ? { usage } : {}), detail: { ...result.detail, testsStep } };
    };
    const subject = `test(${task.id.slice(0, 8)}): scenarios`;
    const testsOf = (facts: ScenarioTagFacts) => Object.entries(facts.tagged).map(([scenario, file]) => ({ scenario, file }));
    // A source file that holds Rust's inline tests holds production code too: the implementer changes it, so it is not a protected test file.
    const protectedOf = (nameStatus: string, facts: ScenarioTagFacts) => pathsOf(nameStatus).filter((p) => !facts.inline.includes(p));
    const worktree = task.worktreePath;
    const headMoved = (reason: string): StageResult => ({ outcome: "escalated", detail: { escalation: "head_moved", headMoved: true, reason, testsStep: { status: "failed", problems: [reason] } } });
    const pathsOf = (nameStatus: string): string[] => nameStatus.split("\n").filter((l) => l.trim()).filter((l) => !l.startsWith("D")).map((l) => l.split("\t").at(-1) ?? "").filter(Boolean);
    // Only the sha the machine itself committed (kept on a finish row the machine wrote) is the tests commit: it must still be on the branch, its parent must be the
    // commit the card's first run started from (a stage_runs row), and its own diff must pass the tag check. A resumed run reads it the same way.
    if (context.testsCommit && worktree) {
      const read = await deps.git.readCommit(worktree, context.testsCommit);
      if (!read) return headMoved("the tests commit the machine made is no longer on the branch: the branch was moved, so nothing is written on it");
      const facts = scenarioTags({ ...read, scenarios });
      if (!context.firstInputCommit || read.parent !== context.firstInputCommit || !facts.ok) return headMoved("the recorded tests commit does not check out against the commit the card's first run started from");
      return withStep(await implementSwept({ scenarioTests: testsOf(facts), scopeBase: context.testsCommit, testsFiles: protectedOf(read.nameStatus, facts), ...(facts.inline.length ? { inlineTests: facts.inline } : {}) }), { status: "committed", commit: context.testsCommit, resumed: true, scenarioTests: testsOf(facts) });
    }
    if (context.resume) return implementSwept({});
    if (await deps.holdout(task.repoPath)) return withStep(await implementSwept({}), { status: "skipped", why: "holdout_cases" });

    const approved = context.approvals.findLast((a) => a.kind === "awaiting_approval" && a.decision === "approved");
    const plan = Plan.safeParse(approved?.requested.plan);
    const escalate = async (where: string, base: string, problems: string[], redChecks?: { scenario: string; verdict: string }[]): Promise<StageResult> => {
      await deps.git.reset(where, base);
      return { outcome: "escalated", ...(writerUsage ? { usage: writerUsage } : {}), detail: { escalation: "other", reason: `the tests step could not make a tagged test that fails for the right reason for every scenario: ${problems.join("; ")}`, testsStep: { status: "failed", problems, ...(redChecks ? { redChecks } : {}) } } };
    };
    // A missing tag is sent back once; a red that is missing or wrong, twice.
    let tagMisses = 0;
    let redMisses = 0;
    let review: string[] | undefined;
    for (;;) {
      const round = await budgeted();
      if (!round) return { ...spentResult(), ...(writerUsage ? { usage: writerUsage } : {}) };
      const written = await deps.runWriter(round, review ? { plan: reviewContext(review) } : {});
      writerUsage = addUsage(writerUsage, written.usage);
      if (written.outcome !== "pass") return withUsage(written, writerUsage);
      const where = written.workspace?.worktreePath ?? worktree;
      if (!where) return { outcome: "fail", detail: { error: "the tests step has no worktree to read" } };
      // The commit the run started from, read by the host before the container ran: the writer's changes are read against it, and a HEAD the container moved is refused.
      const base = written.run?.inputCommit;
      if (!base) return { outcome: "fail", detail: { error: "the tests step does not know the commit the writer started from" } };
      if ((await deps.git.head(where)) !== base) {
        review = ["the writer made a commit: it writes files only, the machine makes the commit"];
        if (tagMisses >= 1) return escalate(where, base, review);
        await deps.git.reset(where, base);
        tagMisses += 1;
        continue;
      }
      // The commit is made on the branch the host chose for the run: a container that switched the worktree to another branch gets nothing committed.
      if (written.workspace?.branch && (await deps.git.branch(where)) !== written.workspace.branch) return headMoved("the worktree is not on the task's branch: the branch was moved");
      const pending = await deps.git.pending(where, base);
      const facts = scenarioTags({ ...pending, scenarios });
      if (!facts.ok) {
        review = problemsOf(facts);
        if (tagMisses >= 1) return escalate(where, base, review);
        tagMisses += 1;
        continue;
      }
      const reds = redsOf(written.detail?.scenarioReds);
      const judged = await Promise.all(
        scenarios.map(async (s) => {
          const id = s.id!;
          const output = reds[id];
          if (output === undefined) return { id, verdict: "missing", problems: [`${id}: no red reported; run its test and report the failing output with scenario_red`] };
          const file = facts.tagged[id];
          const test = file && deps.readTest ? await deps.readTest(where, file, id).catch(() => null) : null;
          const check: CheckContext = { kind: "red", scenario: { id, title: s.title, given: s.given ?? null, when: s.when ?? null, then: s.then ?? null, approach: s.approach }, exists: id in facts.tagged, output, ...(test ? { test } : {}) };
          const vote = await voteRed(deps.judgeRed, check, task.repoPath);
          // The task's events say what each scenario's judge said, so an escalation is never only a sentence.
          await context.emit?.("scenario.red_check", { scenario: id, verdict: vote.verdict, asked: vote.askings.length, flagged: vote.askings.filter((a) => a.flagged).length, testRead: test !== null, ...(vote.problems.length ? { problems: vote.problems.map((p) => safe(p).slice(0, 200)) } : {}) });
          return { id, verdict: vote.verdict, problems: vote.problems.map((p) => `${id}: ${safe(p).slice(0, 200)}`) };
        }),
      );
      const problems = judged.flatMap((j) => j.problems);
      if (problems.length > 0) {
        review = problems;
        if (redMisses >= 2) return escalate(where, base, problems, judged.map((j) => ({ scenario: j.id, verdict: j.verdict })));
        redMisses += 1;
        continue;
      }
      for (const j of judged) await context.emit?.("scenario.red", { scenario: j.id });
      const sha = await deps.git.commit(where, subject, `plan version ${plan.success ? plan.data.version : 2}`);
      await deps.checkpoint(context, where, "red").catch(() => {});
      const result = await implementSwept({ scenarioTests: testsOf(facts), scopeBase: sha, testsFiles: protectedOf(pending.nameStatus, facts), ...(facts.inline.length ? { inlineTests: facts.inline } : {}) });
      const skipped = judged.some((j) => j.verdict === "skipped");
      return withStep(result, { status: "committed", commit: sha, tests: Object.keys(facts.tagged).length, scenarioTests: testsOf(facts), ...(skipped ? { redCheck: "skipped" } : {}) });
    }
  };
}

const withUsage = (result: StageResult, usage: StageResult["usage"]): StageResult => (usage ? { ...result, usage } : result);

const redsOf = (value: unknown): Record<string, string> =>
  value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).filter((e): e is [string, string] => typeof e[1] === "string")) : {};
