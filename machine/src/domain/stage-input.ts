// Builds the /in/stage.json a stage pack reads. The shape is the StageInput contract.
import { type CheckSpec, type CiContext, type DatadogTriageContext, type Finding, type JiraIntakeContext, type Ledger, PACK_LIMITS, type PackId, type QaTarget, type ReviewContext, type RunSummary, type SlackTriageContext, type StageInput, TestCase, type TaskState, type ThreadsContext } from "@hardness/contracts";

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

/** The test cases approved at the last test check; anything malformed is dropped. A case
 *  recorded under schema 2 (`test` for `approach`) is read as today's shape. */
function checkedCases(approvals: ApprovalRow[]): TestCase[] {
  const approval = approvals.findLast((a) => a.kind === "awaiting_test_check" && a.decision === "approved");
  const cases = approval?.requested.cases;
  if (!Array.isArray(cases)) return [];
  return cases.flatMap((c) => {
    const legacy = c as { approach?: unknown; test?: unknown };
    const parsed = TestCase.safeParse(legacy.approach === undefined && typeof legacy.test === "string" ? { ...c, approach: legacy.test } : c);
    return parsed.success ? [parsed.data] : [];
  });
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
  /** For reviewing (a PR task): the PR's diff and comments the host fetched. */
  review?: ReviewContext | null;
  /** For addressing (a PR task): the unresolved threads the host fetched. */
  threads?: ThreadsContext | null;
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
      ...(pack === "reviewing" && opts.review ? { review: opts.review } : {}),
      ...(pack === "addressing" && opts.threads ? { threads: opts.threads } : {}),
      ...(pack === "reviewing_memory" && opts.history ? { ledger: opts.history.ledger, runs: opts.history.runs } : {}),
      // A retry continues the ledger the last attempt left: committed slices are not redone.
      ...(pack === "implementing" && opts.history?.ledger ? { ledger: opts.history.ledger } : {}),
    },
    limits: { maxTurns, timeoutMs },
    env: { LUNA_FACTORY: "1" },
  };
}

/** The id of the synthetic task every slack_triage input carries: the pack is not a task stage. */
export const SLACK_TRIAGE_TASK_ID = "slack-triage";

/** The /in/stage.json the slack_triage pack reads: no task of its own, no plan, no worktree;
 *  the inbox batch rides in `context.slack` and the answer goes back to the inbox. */
export function buildSlackTriageInput(slack: SlackTriageContext): StageInput {
  const { maxTurns, timeoutMs } = PACK_LIMITS.slack_triage;
  return {
    schema: 3,
    stage: "slack_triage",
    pack: "slack_triage",
    attempt: 1,
    task: { id: SLACK_TRIAGE_TASK_ID, title: "Slack triage", description: "", criteria: [], repoPath: "", branch: "", source: null },
    plan: null,
    decisions: [],
    priorFindings: [],
    context: { projectContext: null, slack },
    limits: { maxTurns, timeoutMs },
    env: { LUNA_FACTORY: "1" },
  };
}

/** The id of the synthetic task every datadog_triage input carries: the pack is not a task stage. */
export const DATADOG_TRIAGE_TASK_ID = "datadog-triage";

/** The /in/stage.json the datadog_triage pack reads: no task of its own, no plan, no worktree;
 *  the batch rides in `context.datadog` and the answer goes back to the Datadog inbox. */
export function buildDatadogTriageInput(datadog: DatadogTriageContext): StageInput {
  const { maxTurns, timeoutMs } = PACK_LIMITS.datadog_triage;
  return {
    schema: 3,
    stage: "datadog_triage",
    pack: "datadog_triage",
    attempt: 1,
    task: { id: DATADOG_TRIAGE_TASK_ID, title: "Datadog triage", description: "", criteria: [], repoPath: "", branch: "", source: null },
    plan: null,
    decisions: [],
    priorFindings: [],
    context: { projectContext: null, datadog },
    limits: { maxTurns, timeoutMs },
    env: { LUNA_FACTORY: "1" },
  };
}

/** The id of the synthetic task every jira_intake input carries: the pack runs before a ticket exists. */
export const JIRA_INTAKE_TASK_ID = "jira-intake";

/** The /in/stage.json the jira_intake pack reads: the issue in `context.jira`, the repo it would
 *  land in as the (read-only) worktree, no plan, no branch; the answer decides whether a ticket is made. */
export function buildJiraIntakeInput(jira: JiraIntakeContext): StageInput {
  const { maxTurns, timeoutMs } = PACK_LIMITS.jira_intake;
  return {
    schema: 3,
    stage: "jira_intake",
    pack: "jira_intake",
    attempt: 1,
    task: { id: JIRA_INTAKE_TASK_ID, title: jira.summary, description: jira.description, criteria: [], repoPath: jira.repoPath ?? "", branch: "", source: null },
    plan: null,
    decisions: [],
    priorFindings: [],
    context: { projectContext: null, jira },
    limits: { maxTurns, timeoutMs },
    env: { LUNA_FACTORY: "1" },
  };
}
