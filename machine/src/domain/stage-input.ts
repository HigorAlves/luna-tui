// Builds the /in/stage.json a stage pack reads. The shape is the StageInput contract.
import { type CiContext, type Finding, type PackId, type StageInput, TestCase, type TaskState } from "@hardness/contracts";

import type { ApprovalRow, TaskRow } from "./task.ts";

const MINUTE = 60_000;

/**
 * Turn and time limits, and whether the pack edits the worktree, per pack.
 * orc's factory/stages.json is the source of truth; this mirrors it so the machine does not
 * read orc's files from the host. Change both together.
 */
export const PACK_LIMITS: Record<PackId, { maxTurns: number; timeoutMs: number; writable: boolean }> = {
  triage: { maxTurns: 30, timeoutMs: 10 * MINUTE, writable: false },
  test_design: { maxTurns: 40, timeoutMs: 15 * MINUTE, writable: false },
  implementing: { maxTurns: 80, timeoutMs: 30 * MINUTE, writable: true },
  verifying: { maxTurns: 60, timeoutMs: 20 * MINUTE, writable: true },
  e2e: { maxTurns: 60, timeoutMs: 20 * MINUTE, writable: true },
  evidence: { maxTurns: 0, timeoutMs: 5 * MINUTE, writable: false },
  ci_watch: { maxTurns: 30, timeoutMs: 10 * MINUTE, writable: false },
  reviewing_memory: { maxTurns: 30, timeoutMs: 10 * MINUTE, writable: false },
};

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
}): StageInput {
  const { task, stage, attempt, approvals } = opts;
  const pack = stage as PackId;
  const { maxTurns, timeoutMs } = PACK_LIMITS[pack];
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
    plan: approvedPlan(approvals),
    decisions: approvals
      .filter((a) => a.decision !== null)
      .map((a) => ({
        at: a.kind,
        decision: a.decision as string,
        reason: a.reason,
        answers: (a.response?.answers ?? {}) as Record<string, string>,
      })),
    priorFindings: opts.priorFindings.filter((f) => f.confidence >= PRIOR_FINDING_CONFIDENCE),
    // The container reads docs/agents/project-context.md itself.
    context: {
      projectContext: opts.projectContext ?? null,
      testCases: pack === "implementing" || pack === "verifying" ? checkedCases(approvals) : [],
      baseCommit: opts.baseCommit ?? null,
      ci: opts.ci ?? null,
    },
    limits: { maxTurns, timeoutMs },
    env: { ORC_FACTORY: "1" },
  };
}
