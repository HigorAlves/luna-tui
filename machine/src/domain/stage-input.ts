// Builds the /in/stage.json a stage pack reads. The shape is the StageInput contract.
import { type CiContext, type Finding, type Ledger, PACK_LIMITS, type PackId, type QaTarget, type RunSummary, type StageInput, TestCase, type TaskState, type CheckSpec } from "@hardness/contracts";

export { PACK_LIMITS };

import type { ApprovalRow, TaskRow } from "./task.ts";

const MINUTE = 60_000;

/** Implementing's turns and time scale with the plan's slice count, up to this many times the pack default. */
export const BUDGET_SCALE_MAX = 4;

/** The budget a stage gets: the pack default, or for implementing the default times the slice count (1..4). */
export function budgetFor(pack: PackId, slices: number): { maxTurns: number; timeoutMs: number } {
  const { maxTurns, timeoutMs } = PACK_LIMITS[pack];
  if (pack !== "implementing") return { maxTurns, timeoutMs };
  const factor = Math.min(BUDGET_SCALE_MAX, Math.max(1, slices));
  return { maxTurns: maxTurns * factor, timeoutMs: timeoutMs * factor };
}

/** Findings below this are not fed back to the implementer. */
export const PRIOR_FINDING_CONFIDENCE = 0.8;

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.map((item) => String(item)) : [];

export function approvedPlan(approvals: ApprovalRow[]): StageInput["plan"] {
  const approval = approvals.findLast((a) => a.kind === "awaiting_approval" && a.decision === "approved");
  if (!approval) return null;
  const requested = approval.requested;
  return {
    brief: typeof requested.brief === "string" ? requested.brief : "",
    criteria: strings(requested.criteria),
    assumptions: strings(requested.assumptions),
    ...(Array.isArray(requested.slices) ? { slices: requested.slices } : {}),
  };
}

/** The test cases approved at the last test check; anything malformed is dropped. */
function checkedCases(approvals: ApprovalRow[]): TestCase[] {
  const approval = approvals.findLast((a) => a.kind === "awaiting_test_check" && a.decision === "approved");
  const cases = approval?.requested.cases;
  return Array.isArray(cases) ? cases.flatMap((c) => (TestCase.safeParse(c).success ? [c as TestCase] : [])) : [];
}

export function buildStageInput(opts: {
  task: TaskRow;
  stage: TaskState;
  attempt: number;
  approvals: ApprovalRow[];
  priorFindings: Finding[];
  projectContext?: string | null;
  /** Where the task branch forked from the repo; verifying diffs against it. */
  baseCommit?: string | null;
  /** For ci_watch: the PR, checks and failed-run log the host fetched. */
  ci?: CiContext | null;
  /** The repo's PIPELINE.md holds test_design's cases out of implementing's input, so the
   *  implementer cannot overfit to them; verifying still judges by them. */
  holdoutCases?: boolean;
  /** For e2e: the repo's QA targets from luna.yaml. */
  qaTargets?: QaTarget[];
  /** For implementing and verifying: the repo's checks from luna.yaml. */
  checks?: CheckSpec[] | null;
  /** For reviewing_memory: the last implementing ledger and every earlier run of the task. */
  history?: { ledger: Ledger | null; runs: RunSummary[] } | null;
}): StageInput {
  const { task, stage, attempt, approvals } = opts;
  const pack = stage as PackId;
  const plan = approvedPlan(approvals);
  const { maxTurns, timeoutMs } = budgetFor(pack, plan?.slices?.length ?? 0);
  return {
    schema: 3,
    stage,
    pack,
    attempt,
    task: {
      id: task.id,
      title: task.title,
      description: task.description,
      criteria: task.criteria,
      repoPath: task.repoPath ?? "",
      branch: task.branch ?? "",
      source: task.source,
    },
    plan,
    decisions: approvals
      .filter((a) => a.decision !== null)
      .map((a) => ({
        at: a.kind,
        decision: a.decision as string,
        reason: a.reason,
        answers: (a.response?.answers ?? {}) as Record<string, string>,
      })),
    priorFindings: opts.priorFindings.filter((f) => f.confidence >= PRIOR_FINDING_CONFIDENCE),
    // The runner reads docs/agents/project-context.md from the worktree itself.
    context: {
      projectContext: opts.projectContext ?? null,
      testCases:
        pack === "verifying" || (pack === "implementing" && !opts.holdoutCases) ? checkedCases(approvals) : [],
      baseCommit: opts.baseCommit ?? null,
      ci: opts.ci ?? null,
      ...(pack === "e2e" && opts.qaTargets ? { qaTargets: opts.qaTargets } : {}),
      ...((pack === "implementing" || pack === "verifying") && opts.checks ? { checks: opts.checks } : {}),
      ...(pack === "reviewing_memory" && opts.history ? { ledger: opts.history.ledger, runs: opts.history.runs } : {}),
      // A retry continues the ledger the last attempt left: committed slices are not redone.
      ...(pack === "implementing" && opts.history?.ledger ? { ledger: opts.history.ledger } : {}),
    },
    limits: { maxTurns, timeoutMs },
    env: { LUNA_FACTORY: "1" },
  };
}
