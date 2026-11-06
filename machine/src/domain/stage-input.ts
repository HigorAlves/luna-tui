// Builds the /in/stage.json a stage pack reads. The shape is the StageInput contract.
import { type ChatTriageContext, type TicketContext, type ConversationContext, type MemoryAnswerContext, CodeMapAnswer, Plan, PlanRisk, type Scenario, criteriaOf, scenarioOf, type CheckContext, type CheckSpec, type DedupContext, type SizeContext, type SplitContext, type IntakeContext, type CiContext, type CoverageSummary, type EngineId, type EvidenceContext, type Finding, type GraphContext, type IssueContext, type JiraIntakeContext, type Ledger, type PlanContext, PACK_LIMITS, type PackId, type QaTarget, type ReviewContext, type RunSummary, type ShipContext, type SlackTriageContext, type StageInput, TestCase, type TaskState, type ThreadsContext, type VideoContext } from "@hardness/contracts";

export { PACK_LIMITS };

import { cardOf } from "./card-fields.ts";
import { safe } from "./evidence-markdown.ts";
import type { ContextPackId, PackContext } from "./context-packs.ts";
import type { ApprovalRow, TaskRow } from "./task.ts";

/** The packs that read `context.video`. */
const VIDEO_PACKS: ReadonlySet<PackId> = new Set<PackId>(["video_script", "recording", "video_qa", "video_fix"]);

const MINUTE = 60_000;

/** The synthetic task's title for a check context sent to a decision pack. */
function checkTitle(check: CheckContext): string {
  if (check.kind === "finding") return `Finding: ${check.finding?.title ?? "?"}`;
  if (check.kind === "e2e") return `E2E failure: attempt ${check.e2e?.attempt ?? "?"}`;
  return check.kind === "red" ? "Red check" : check.kind === "escalation" ? "Escalation reason" : "Scope check";
}

/** The synthetic task's title for an evidence context sent to evidence_format. */
function evidenceTitle(evidence: EvidenceContext): string {
  return evidence.record ? `Evidence format: ${evidence.record.goal}` : "Evidence format";
}

/** The synthetic task's title for a ship context sent to one of Ship's decisions. */
function shipTitle(ship: ShipContext, retroTitle?: string): string {
  if (ship.kind === "event") return `PR event: ${ship.event?.actor ?? "?"} ${ship.event?.kind ?? "?"}`;
  if (ship.kind === "comment") return `Comment on ${ship.comment?.thread.path ?? "the PR"}`;
  if (ship.kind === "fix") return `Fix: ${ship.fix?.threadSummary ?? "?"}`;
  return `Retro: ${retroTitle ?? "task"}`;
}

/** Implementing's turns and time scale with the plan's slice count, up to this many times the pack default. */
export const BUDGET_SCALE_MAX = 4;

/** The budget a stage gets: the pack default, or for implementing the default times the slice count (1..4). */
export function budgetFor(pack: PackId, slices: number): { maxTurns: number; timeoutMs: number } {
  const { maxTurns, timeoutMs } = PACK_LIMITS[pack];
  if (pack !== "implementing") return { maxTurns, timeoutMs };
  const factor = Math.min(BUDGET_SCALE_MAX, Math.max(1, slices));
  return { maxTurns: maxTurns * factor, timeoutMs: timeoutMs * factor };
}

/** A failed sweep reaches the implementer as at most this many checks, each output cut to this many characters from the end. */
const SWEEP_FAILURES_MAX = 5;
const SWEEP_TAIL_CAP = 2000;

/** Findings below this are not fed back to the implementer. */
export const PRIOR_FINDING_CONFIDENCE = 0.8;

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.map((item) => String(item)) : [];

export function approvedPlan(approvals: ApprovalRow[]): StageInput["plan"] {
  const approval = approvals.findLast((a) => a.kind === "awaiting_approval" && a.decision === "approved");
  if (!approval) return null;
  const requested = approval.requested;
  const map = CodeMapAnswer.safeParse(requested.map);
  const risk = PlanRisk.safeParse(requested.risk);
  return {
    brief: typeof requested.brief === "string" ? requested.brief : "",
    criteria: strings(requested.criteria),
    assumptions: strings(requested.assumptions),
    ...(Array.isArray(requested.slices) ? { slices: requested.slices } : {}),
    ...(typeof requested.rollback === "string" ? { rollback: requested.rollback } : {}),
    ...(map.success ? { map: map.data } : {}),
    ...(risk.success ? { risk: risk.data } : {}),
  };
}

/** The test cases approved at the last test check; anything malformed is dropped. A case
 *  recorded under schema 2 (`test` for `approach`) is read as today's shape. */
export function approvedCases(approvals: ApprovalRow[]): TestCase[] {
  // The one approval carries the scenarios now; a legacy test check, when a task has one, wins.
  const approval =
    approvals.findLast((a) => a.kind === "awaiting_test_check" && a.decision === "approved") ??
    approvals.findLast((a) => a.kind === "awaiting_approval" && a.decision === "approved" && Array.isArray(a.requested.cases));
  const cases = approval?.requested.cases;
  if (!Array.isArray(cases)) return [];
  return cases.flatMap((c) => {
    const legacy = c as { approach?: unknown; test?: unknown };
    const parsed = TestCase.safeParse(legacy.approach === undefined && typeof legacy.test === "string" ? { ...c, approach: legacy.test } : c);
    return parsed.success ? [parsed.data] : [];
  });
}

/** The approved cases as scenarios with ids: a case without one (a gate approved before v2.2) takes its position, `S1`... */
export function approvedScenarios(approvals: ApprovalRow[]): Scenario[] {
  const approved = approvals.findLast((a) => a.kind === "awaiting_approval" && a.decision === "approved");
  const criteria = criteriaOf(strings(approved?.requested.criteria));
  const plan = Plan.safeParse(approved?.requested.plan);
  return approvedCases(approvals).map((c, i) => scenarioOf(c, i, plan.success ? plan.data.acceptance_criteria : criteria));
}

/** What Intake gathered, as triage reads it: each stranger's text flattened again and capped, every list bounded, attachments as references only. */
export function intakeOf(task: TaskRow, similar?: IntakeContext["similar"]): IntakeContext {
  const card = cardOf(task);
  const hints = card.hints ? Object.fromEntries(Object.entries(card.hints).map(([k, v]) => [k, typeof v === "string" ? safe(v).slice(0, 120) : v])) : null;
  return {
    project: card.project ?? null,
    owners: (card.owners ?? []).slice(0, 20),
    reporter: card.reporter ? { id: card.reporter.id, ...(card.reporter.channel ? { channel: card.reporter.channel } : {}), ...(card.reporter.name ? { name: safe(card.reporter.name).slice(0, 120) } : {}) } : null,
    history: (card.history ?? []).slice(0, 50).map((h) => ({ author: h.author ? safe(h.author).slice(0, 60) : null, text: safe(h.text).slice(0, 500) })),
    attachments: (card.attachments ?? []).slice(0, 20).map((a) => ({ name: safe(a.name).slice(0, 120), url: a.url, ...(a.mediaType ? { mediaType: safe(a.mediaType).slice(0, 80) } : {}), ...(a.size !== undefined ? { size: a.size } : {}) })),
    hints: hints && Object.keys(hints).length ? (hints as IntakeContext["hints"]) : null,
    ...(similar?.length ? { similar: similar.slice(0, 5).map((s) => ({ card: s.card, text: safe(s.text).slice(0, 400) })) } : {}),
  };
}

export function buildStageInput(opts: {
  task: TaskRow;
  stage: TaskState;
  /** The pack to run when it is not the one the state is named for (the planner runs in test_design). */
  pack?: PackId;
  /** A plan under review: handed to the stage as `context.plan`, and, before any approval, as the plan it reads. */
  plan?: PlanContext | null;
  /** The engine engine-choice picked; absent, the factory runs the pack's default. */
  engine?: EngineId;
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
  /** For implementing: the checks Build's regression sweep saw fail, with the tail of each one's output. */
  sweepFailures?: { name: string; tail: string }[];
  /** For triage: similar past cards' recalled outcomes from memory (predicted against actual), rendered as data; absent, none. */
  similarOutcomes?: IntakeContext["similar"];
  /** For implementing: the minutes Build's budget has left; the run's time limit is the smaller of its own and this. */
  budgetMinutes?: number;
  /** For implementing: the tests Build's tests step wrote, one entry per scenario. */
  scenarioTests?: { scenario: string; file: string }[];
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
  /** For pr_reply: the thread and the pack the host built; for reviewing_memory: the retro facts. */
  ship?: ShipContext | null;
  /** Where the repo's code graph is in the container and how current it is; null when it has none. */
  graph?: GraphContext | null;
  /** For the video packs: the scenarios, target, narration and the film's measurements. */
  video?: VideoContext | null;
  /** For verifying: the files the code graph says depend on what the change touched. */
  blastRadius?: string[];
  /** For verifying: how much of the change's added lines the repo's lcov report saw run. */
  coverage?: CoverageSummary;
}): StageInput {
  const { task, stage, attempt, approvals } = opts;
  const pack = opts.pack ?? (stage as PackId);
  // The test designer designs from the criteria and the goal: it is never shown the plan's steps, brief or assumptions.
  const designer = pack === "test_design" || pack === "test_design_fast";
  const designed: PlanContext | null = designer && opts.plan ? { record: opts.plan.record, brief: "", criteria: opts.plan.criteria, assumptions: [], slices: [], ...(opts.plan.cases ? { cases: opts.plan.cases } : {}), ...(opts.plan.gaps ? { gaps: opts.plan.gaps } : {}), ...(opts.plan.coverage_notes ? { coverage_notes: opts.plan.coverage_notes } : {}), ...(opts.plan.round !== undefined ? { round: opts.plan.round } : {}) } : null;
  const reviewed = designed ?? opts.plan;
  const underReview = reviewed
    ? { brief: reviewed.brief, criteria: reviewed.criteria, assumptions: reviewed.assumptions, ...(designer ? {} : { slices: reviewed.slices }), ...(reviewed.rollback !== undefined ? { rollback: reviewed.rollback } : {}) }
    : null;
  const plan = approvedPlan(approvals) ?? underReview;
  const scaled = budgetFor(pack, plan?.slices?.length ?? 0);
  const { maxTurns } = scaled;
  // Build's budget: a run never outlives the minutes the card has left.
  const timeoutMs = opts.budgetMinutes !== undefined && (pack === "implementing" || pack === "build_tests") ? Math.min(scaled.timeoutMs, Math.max(1, opts.budgetMinutes) * MINUTE) : scaled.timeoutMs;
  return {
    schema: 3,
    stage,
    pack,
    ...(opts.engine ? { engine: opts.engine } : {}),
    attempt,
    task: {
      id: task.id,
      title: task.title,
      description: task.description,
      criteria: task.criteria,
      repoPath: task.repoPath ?? "",
      branch: task.branch ?? "",
      source: task.source,
      record: task.record,
      classification: task.classification,
      evidence: task.evidence,
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
        pack === "verifying" || pack === "e2e" || pack === "video_script" || pack === "video_fix" || pack === "recording" || (pack === "implementing" && !opts.holdoutCases)
          ? approvedCases(approvals)
          : pack === "build_tests"
            ? approvedScenarios(approvals)
            : [],
      ...(pack === "implementing" && opts.scenarioTests?.length ? { scenarioTests: opts.scenarioTests } : {}),
      ...(pack === "implementing" && opts.sweepFailures?.length ? { sweepFailures: opts.sweepFailures.slice(0, SWEEP_FAILURES_MAX).map((f) => ({ name: safe(f.name).slice(0, 60), tail: safe(f.tail.slice(-SWEEP_TAIL_CAP)).slice(-SWEEP_TAIL_CAP) })) } : {}),
      baseCommit: opts.baseCommit ?? null,
      ...(pack === "triage" ? { intake: intakeOf(task, opts.similarOutcomes) } : {}),
      ci: opts.ci ?? null,
      graph: opts.graph ?? null,
      ...(opts.plan ? { plan: reviewed ?? opts.plan } : {}),
      ...(pack === "verifying" && opts.blastRadius?.length ? { blastRadius: opts.blastRadius } : {}),
      ...(pack === "verifying" && opts.coverage ? { coverage: opts.coverage } : {}),
      ...((pack === "e2e" || pack === "recording") && opts.qaTargets ? { qaTargets: opts.qaTargets } : {}),
      ...(VIDEO_PACKS.has(pack) && opts.video ? { video: opts.video } : {}),
      ...((pack === "implementing" || pack === "verifying") && opts.checks ? { checks: opts.checks } : {}),
      ...(pack === "reviewing" && opts.review ? { review: opts.review } : {}),
      ...(pack === "addressing" && opts.threads ? { threads: opts.threads } : {}),
      ...((pack === "pr_reply" || pack === "reviewing_memory") && opts.ship ? { ship: opts.ship } : {}),
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
export function buildSlackTriageInput(slack: SlackTriageContext, engine?: EngineId): StageInput {
  const { maxTurns, timeoutMs } = PACK_LIMITS.slack_triage;
  return {
    schema: 3,
    stage: "slack_triage",
    pack: "slack_triage",
    ...(engine ? { engine } : {}),
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

/** The id of the synthetic task every jira_intake input carries: the pack runs before a ticket exists. */
export const JIRA_INTAKE_TASK_ID = "jira-intake";

/** The /in/stage.json the jira_intake pack reads: the issue in `context.jira`, the repo it would
 *  land in as the (read-only) worktree, no plan, no branch; the answer decides whether a ticket is made. */
export function buildJiraIntakeInput(jira: JiraIntakeContext, engine?: EngineId): StageInput {
  const { maxTurns, timeoutMs } = PACK_LIMITS.jira_intake;
  return {
    schema: 3,
    stage: "jira_intake",
    pack: "jira_intake",
    ...(engine ? { engine } : {}),
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

/** The /in/stage.json a context-only pack reads on data a client sent (`POST /runs`): a synthetic
 *  task named after the pack, no plan, no branch, the context under the pack's own key. The
 *  Slack and Jira packs get exactly the input their own runners build. */
export function buildContextPackInput(pack: ContextPackId, context: PackContext, engine?: EngineId): StageInput {
  if ("slack" in context) return buildSlackTriageInput(context.slack, engine);
  if ("jira" in context) return buildJiraIntakeInput(context.jira, engine);
  const { maxTurns, timeoutMs } = PACK_LIMITS[pack];
  const issue: IssueContext | null = "issue" in context ? context.issue : null;
  const chat: ChatTriageContext | null = "chat" in context ? context.chat : null;
  const plan: PlanContext | null = "plan" in context ? context.plan : null;
  const check: CheckContext | null = "check" in context ? context.check : null;
  const evidence: EvidenceContext | null = "evidence" in context ? context.evidence : null;
  const ship: ShipContext | null = "ship" in context ? context.ship : null;
  const dedup: DedupContext | null = "dedup" in context ? context.dedup : null;
  const size: SizeContext | null = "size" in context ? context.size : null;
  const split: SplitContext | null = "split" in context ? context.split : null;
  // The ticket and conversation packs: their whole context is the ticket or the thread. Left out, a pack runs blind.
  const ticket: TicketContext | null = "ticket" in context ? context.ticket : null;
  const conversation: ConversationContext | null = "conversation" in context ? context.conversation : null;
  const memoryAnswer: MemoryAnswerContext | null = "memoryAnswer" in context ? context.memoryAnswer : null;
  return {
    schema: 3,
    stage: pack,
    pack,
    ...(engine ? { engine } : {}),
    attempt: 1,
    task: { id: pack.replace(/_/g, "-"), title: (ticket ? `${ticket.key}: ${ticket.title}` : null) ?? (conversation ? "Conversation" : null) ?? (memoryAnswer ? "Memory answer" : null) ?? issue?.title ?? dedup?.title ?? size?.title ?? split?.origin.title ?? plan?.brief.split("\n")[0] ?? (check ? checkTitle(check) : evidence ? evidenceTitle(evidence) : ship ? shipTitle(ship) : "Chat triage"), description: issue?.description ?? "", criteria: [], repoPath: "", branch: "", source: null },
    plan: null,
    decisions: [],
    priorFindings: [],
    context: { projectContext: null, ...(issue ? { issue } : {}), ...(chat ? { chat } : {}), ...(plan ? { plan } : {}), ...(check ? { check } : {}), ...(evidence ? { evidence } : {}), ...(ship ? { ship } : {}), ...(dedup ? { dedup } : {}), ...(size ? { size } : {}), ...(split ? { split } : {}), ...(ticket ? { ticket } : {}), ...(conversation ? { conversation } : {}), ...(memoryAnswer ? { memoryAnswer } : {}) },
    limits: { maxTurns, timeoutMs },
    env: { LUNA_FACTORY: "1" },
  };
}
