// Build's tests step: before the implementer runs, a test writer makes one failing test per approved scenario, tagged `@scenario:<id>`.
// The machine checks the diff by script (`scenarioTags`), makes the commit itself, and only then runs the implementer. The feature route only.
import { type CheckContext, Plan, type PlanContext } from "@hardness/contracts";

import { approvedScenarios } from "../../domain/stage-input.ts";
import { safe } from "../../domain/evidence-markdown.ts";
import { isPlainRepoPath } from "@hardness/contracts";
import { type ScenarioTagFacts, scenarioTags } from "../../domain/scenario-tags.ts";
import type { StageContext, StageResult, StageRunner } from "../ports.ts";
import type { SweepOutcome } from "./sweep.ts";

/** A tree the writer left, or a commit the step made earlier: what git says changed, and the diff. */
export interface TestsDiff {
  nameStatus: string;
  diff: string;
}

export interface BuildTestsDeps {
  /** The implementer, handed the tests the step made (by scenario). */
  implement: (context: StageContext, extra: { scenarioTests?: { scenario: string; file: string }[]; sweepFailures?: { name: string; tail: string }[] }) => Promise<StageResult>;
  /** The test writer, as a sub-run; a second round carries what the first left out as `plan.review`. */
  runWriter: (context: StageContext, extra: { plan?: PlanContext }) => Promise<StageResult>;
  /** The red_check decision for one scenario's test; `skipped` when it did not answer in time (it never blocks). `problems` are what a confident no said is wrong. */
  judgeRed: (check: CheckContext, repoPath: string | null) => Promise<{ verdict: string; problems: string[] }>;
  /** Pushes the tests commit to the checkpoint ref before the implementer runs (a push that fails is a note, never a failure). */
  checkpoint: (context: StageContext, worktree: string, follows: "red" | "green") => Promise<void>;
  /** The regression sweep by script, after the implementer's last slice is green. */
  sweep: (context: StageContext) => Promise<SweepOutcome>;
  /** True when Build's budget is spent, so a failed sweep does not get another implementer run. */
  budgetSpent?: (context: StageContext) => Promise<boolean>;
  /** The repo's `holdout_cases`: the implementer must not see the scenarios, so no test is written for it to read. */
  holdout: (repoPath: string) => Promise<boolean>;
  git: {
    /** Stages everything the writer left in the worktree and says what that adds to HEAD. */
    pending: (worktree: string) => Promise<TestsDiff>;
    /** Commits what is staged; the sha. */
    commit: (worktree: string, subject: string, body: string) => Promise<string>;
    /** Drops everything the writer left. */
    discard: (worktree: string) => Promise<void>;
    /** The commit an earlier run of this step made on the card's branch, with what it changed. */
    findTestsCommit: (worktree: string, subject: string) => Promise<({ sha: string } & TestsDiff) | null>;
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
  const tokens = a.tokens || b.tokens ? { input: (a.tokens?.input ?? 0) + (b.tokens?.input ?? 0), output: (a.tokens?.output ?? 0) + (b.tokens?.output ?? 0) } : null;
  return { turns: sum(a.turns, b.turns), costUsd: sum(a.costUsd, b.costUsd), tokens } satisfies Usage;
}

/** What the diff check found wrong, as lines to send back or to say: ids and plain paths only. */
function problemsOf(facts: ScenarioTagFacts): string[] {
  const path = (p: string) => (isPlainRepoPath(p) ? safe(p).slice(0, 120) : "(a path that is not a plain repository path)");
  return [
    ...(facts.missing.length ? [`no test tagged @scenario:<id> for ${facts.missing.slice(0, MAX_NAMED).join(", ")}`] : []),
    ...(facts.nonTest.length ? [`only test files and fixtures beside them may change; not ${facts.nonTest.slice(0, MAX_NAMED).map(path).join(", ")}`] : []),
    ...(facts.removed.length ? [`a test file was removed: ${facts.removed.slice(0, MAX_NAMED).map(path).join(", ")}`] : []),
  ];
}

const reviewContext = (review: string[]): PlanContext => ({ record: null, brief: "", criteria: [], assumptions: [], slices: [], review });

export function buildTestsStep(deps: BuildTestsDeps): StageRunner {
  return async (context) => {
    const { task } = context;
    /** The implementer, and after its last slice the regression sweep: a failing check sends it round again with the check's name and output. */
    const implementSwept = async (extra: Parameters<BuildTestsDeps["implement"]>[1]): Promise<StageResult> => {
      let result = await deps.implement(context, extra);
      let usage = result.usage;
      for (let fixes = 0; ; fixes++) {
        if (result.outcome !== "pass") return result;
        const sweep = await deps.sweep(context);
        const summary = { status: sweep.status, ran: sweep.ran, ...(sweep.note ? { note: sweep.note } : {}), ...(sweep.failed.length ? { failed: sweep.failed.map((f) => f.name) } : {}) };
        const done = (outcome: StageResult): StageResult => ({ ...outcome, ...(usage ? { usage } : {}), detail: { ...outcome.detail, sweep: summary } });
        if (sweep.aborted) return done({ outcome: "fail", detail: { error: "aborted" } });
        if (sweep.missingTool) return done({ outcome: "escalated", detail: { envBroken: true, reason: `\`${safe(sweep.missingTool.cmd).slice(0, 200)}\` cannot run: the runner image lacks the tool (${safe(sweep.missingTool.tail).slice(0, 200)})` } });
        if (sweep.status !== "failed") return done(result);
        const names = sweep.failed.map((f) => safe(f.name).slice(0, 60));
        await context.emit?.("build.sweep_failed", { checks: names });
        if (fixes >= MAX_SWEEP_FIXES || (await deps.budgetSpent?.(context))) {
          return done({ outcome: "fail", detail: { error: `the regression sweep failed: ${names.join(", ")}`, sweepFailures: sweep.failed } });
        }
        result = await deps.implement(context, { ...extra, sweepFailures: sweep.failed });
        usage = addUsage(usage, result.usage);
      }
    };
    const scenarios = approvedScenarios(context.approvals);
    if (task.route !== "feature") return deps.implement(context, {});
    if (context.resume || !task.repoPath || scenarios.length === 0) return implementSwept({});

    /** What the writer's runs cost: added to the run the stage reports, so the budget counts them. */
    let writerUsage: StageResult["usage"];
    const withStep = (result: StageResult, testsStep: Record<string, unknown>): StageResult => {
      const usage = addUsage(writerUsage, result.usage);
      return { ...result, ...(usage ? { usage } : {}), detail: { ...result.detail, testsStep } };
    };
    if (await deps.holdout(task.repoPath)) return withStep(await implementSwept({}), { status: "skipped", why: "holdout_cases" });

    const subject = `test(${task.id.slice(0, 8)}): scenarios`;
    const testsOf = (facts: ScenarioTagFacts) => Object.entries(facts.tagged).map(([scenario, file]) => ({ scenario, file }));
    const worktree = task.worktreePath;
    const earlier = worktree ? await deps.git.findTestsCommit(worktree, subject) : null;
    if (earlier) {
      const facts = scenarioTags({ ...earlier, scenarios });
      return withStep(await implementSwept({ scenarioTests: testsOf(facts) }), { status: "committed", commit: earlier.sha, resumed: true });
    }

    const approved = context.approvals.findLast((a) => a.kind === "awaiting_approval" && a.decision === "approved");
    const plan = Plan.safeParse(approved?.requested.plan);
    const escalate = async (where: string, problems: string[]): Promise<StageResult> => {
      await deps.git.discard(where);
      return { outcome: "escalated", ...(writerUsage ? { usage: writerUsage } : {}), detail: { escalation: "other", reason: `the tests step could not make a tagged test that fails for the right reason for every scenario: ${problems.join("; ")}`, testsStep: { status: "failed", problems } } };
    };
    // A missing tag is sent back once; a red that is missing or wrong, twice.
    let tagMisses = 0;
    let redMisses = 0;
    let review: string[] | undefined;
    for (;;) {
      const written = await deps.runWriter(context, review ? { plan: reviewContext(review) } : {});
      writerUsage = addUsage(writerUsage, written.usage);
      if (written.outcome !== "pass") return withUsage(written, writerUsage);
      const where = written.workspace?.worktreePath ?? worktree;
      if (!where) return { outcome: "fail", detail: { error: "the tests step has no worktree to read" } };
      const pending = await deps.git.pending(where);
      const facts = scenarioTags({ ...pending, scenarios });
      if (!facts.ok) {
        review = problemsOf(facts);
        if (tagMisses >= 1) return escalate(where, review);
        tagMisses += 1;
        continue;
      }
      const reds = redsOf(written.detail?.scenarioReds);
      const judged = await Promise.all(
        scenarios.map(async (s) => {
          const id = s.id!;
          const output = reds[id];
          if (output === undefined) return { id, verdict: "missing", problems: [`${id}: no red reported; run its test and report the failing output with scenario_red`] };
          const check: CheckContext = { kind: "red", scenario: { id, title: s.title, given: s.given ?? null, when: s.when ?? null, then: s.then ?? null, approach: s.approach }, exists: id in facts.tagged, output };
          const answer = await deps.judgeRed(check, task.repoPath);
          return { id, verdict: answer.verdict, problems: answer.problems.map((p) => `${id}: ${safe(p).slice(0, 200)}`) };
        }),
      );
      const problems = judged.flatMap((j) => j.problems);
      if (problems.length > 0) {
        review = problems;
        if (redMisses >= 2) return escalate(where, problems);
        redMisses += 1;
        continue;
      }
      for (const j of judged) await context.emit?.("scenario.red", { scenario: j.id });
      const sha = await deps.git.commit(where, subject, `plan version ${plan.success ? plan.data.version : 2}`);
      await deps.checkpoint(context, where, "red").catch(() => {});
      const result = await implementSwept({ scenarioTests: testsOf(facts) });
      const skipped = judged.some((j) => j.verdict === "skipped");
      return withStep(result, { status: "committed", commit: sha, tests: Object.keys(facts.tagged).length, ...(skipped ? { redCheck: "skipped" } : {}) });
    }
  };
}

const withUsage = (result: StageResult, usage: StageResult["usage"]): StageResult => (usage ? { ...result, usage } : result);

const redsOf = (value: unknown): Record<string, string> =>
  value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).filter((e): e is [string, string] => typeof e[1] === "string")) : {};
