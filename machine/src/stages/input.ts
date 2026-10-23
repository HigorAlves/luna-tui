// Builds the /in/stage.json a stage pack reads. The shape is the StageInput contract.
import type { Finding, PackId, StageInput, TaskState } from "@hardness/contracts";

import type { ApprovalRow, TaskRow } from "../db/entities.ts";

const MINUTE = 60_000;

/**
 * Turn and time limits, and whether the pack edits the worktree, per pack.
 * orc's factory/stages.json is the source of truth; this mirrors it so the machine does not
 * read orc's files from the host. Change both together.
 */
export const PACK_LIMITS: Record<PackId, { maxTurns: number; timeoutMs: number; writable: boolean }> = {
  triage: { maxTurns: 30, timeoutMs: 10 * MINUTE, writable: false },
  test_design: { maxTurns: 40, timeoutMs: 15 * MINUTE, writable: true },
  implementing: { maxTurns: 80, timeoutMs: 30 * MINUTE, writable: true },
  verifying: { maxTurns: 40, timeoutMs: 15 * MINUTE, writable: false },
  e2e: { maxTurns: 60, timeoutMs: 20 * MINUTE, writable: true },
  evidence: { maxTurns: 0, timeoutMs: 5 * MINUTE, writable: false },
  ci_watch: { maxTurns: 30, timeoutMs: 10 * MINUTE, writable: false },
  reviewing_memory: { maxTurns: 30, timeoutMs: 10 * MINUTE, writable: false },
};

/** Findings below this are not fed back to the implementer. */
export const PRIOR_FINDING_CONFIDENCE = 0.8;

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.map((item) => String(item)) : [];

function approvedPlan(approvals: ApprovalRow[]): StageInput["plan"] {
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

/** The test files the user checked at the last test check, as repo-relative paths. */
function checkedTests(approvals: ApprovalRow[]): string[] {
  const approval = approvals.findLast((a) => a.kind === "awaiting_test_check" && a.decision === "approved");
  return approval ? strings(approval.requested.tests) : [];
}

export function buildStageInput(opts: {
  task: TaskRow;
  stage: TaskState;
  attempt: number;
  approvals: ApprovalRow[];
  priorFindings: Finding[];
  projectContext?: string | null;
  /** Overrides the test files taken from the test check approval. */
  tests?: string[];
}): StageInput {
  const { task, stage, attempt, approvals } = opts;
  const pack = stage as PackId;
  const { maxTurns, timeoutMs } = PACK_LIMITS[pack];
  return {
    schema: 1,
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
    context: { projectContext: opts.projectContext ?? null, tests: opts.tests ?? (pack === "implementing" ? checkedTests(approvals) : []) },
    limits: { maxTurns, timeoutMs },
    env: { ORC_FACTORY: "1" },
  };
}
