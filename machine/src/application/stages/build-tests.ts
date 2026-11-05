// Build's tests step: before the implementer runs, a test writer makes one failing test per approved scenario, tagged `@scenario:<id>`.
// The machine checks the diff by script (`scenarioTags`), makes the commit itself, and only then runs the implementer. The feature route only.
import { Plan, type PlanContext } from "@hardness/contracts";

import { approvedScenarios } from "../../domain/stage-input.ts";
import { safe } from "../../domain/evidence-markdown.ts";
import { isPlainRepoPath } from "@hardness/contracts";
import { type ScenarioTagFacts, scenarioTags } from "../../domain/scenario-tags.ts";
import type { StageContext, StageResult, StageRunner } from "../ports.ts";

/** A tree the writer left, or a commit the step made earlier: what git says changed, and the diff. */
export interface TestsDiff {
  nameStatus: string;
  diff: string;
}

export interface BuildTestsDeps {
  /** The implementer, handed the tests the step made (by scenario). */
  implement: (context: StageContext, extra: { scenarioTests?: { scenario: string; file: string }[] }) => Promise<StageResult>;
  /** The test writer, as a sub-run; a second round carries what the first left out as `plan.review`. */
  runWriter: (context: StageContext, extra: { plan?: PlanContext }) => Promise<StageResult>;
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
    const scenarios = approvedScenarios(context.approvals);
    if (task.route !== "feature" || context.resume || !task.repoPath || scenarios.length === 0) return deps.implement(context, {});

    const withStep = (result: StageResult, testsStep: Record<string, unknown>): StageResult => ({ ...result, detail: { ...result.detail, testsStep } });
    if (await deps.holdout(task.repoPath)) return withStep(await deps.implement(context, {}), { status: "skipped", why: "holdout_cases" });

    const subject = `test(${task.id.slice(0, 8)}): scenarios`;
    const testsOf = (facts: ScenarioTagFacts) => Object.entries(facts.tagged).map(([scenario, file]) => ({ scenario, file }));
    const worktree = task.worktreePath;
    const earlier = worktree ? await deps.git.findTestsCommit(worktree, subject) : null;
    if (earlier) {
      const facts = scenarioTags({ ...earlier, scenarios });
      return withStep(await deps.implement(context, { scenarioTests: testsOf(facts) }), { status: "committed", commit: earlier.sha, resumed: true });
    }

    const approved = context.approvals.findLast((a) => a.kind === "awaiting_approval" && a.decision === "approved");
    const plan = Plan.safeParse(approved?.requested.plan);
    let review: string[] | undefined;
    for (let round = 1; round <= 2; round++) {
      const written = await deps.runWriter(context, review ? { plan: reviewContext(review) } : {});
      if (written.outcome !== "pass") return written;
      const where = written.workspace?.worktreePath ?? worktree;
      if (!where) return { outcome: "fail", detail: { error: "the tests step has no worktree to read" } };
      const pending = await deps.git.pending(where);
      const facts = scenarioTags({ ...pending, scenarios });
      if (facts.ok) {
        const sha = await deps.git.commit(where, subject, `plan version ${plan.success ? plan.data.version : 2}`);
        const result = await deps.implement(context, { scenarioTests: testsOf(facts) });
        return withStep(result, { status: "committed", commit: sha, tests: Object.keys(facts.tagged).length });
      }
      review = problemsOf(facts);
      if (round === 2) {
        await deps.git.discard(where);
        return { outcome: "escalated", detail: { escalation: "other", reason: `the tests step could not make a tagged failing test for every scenario: ${review.join("; ")}`, testsStep: { status: "failed", problems: review } } };
      }
    }
    return { outcome: "fail", detail: { error: "unreachable" } };
  };
}
