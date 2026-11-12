// Applies engine transitions to Postgres and runs stages. Every transition happens in a
// transaction that locks the task row, so two requests cannot move one task at once, and
// a rejected event leaves no trace. Stages run in a background loop per task, so requests
// return as soon as the transition is stored.
import { looksLikeTestPath } from "../domain/locked-files.ts";
import { z } from "zod";

import { type ArchiveReason, type BuildProgress, type BuildReport, type BudgetAlert, type CredentialOwner, EscalationReason, type EditPlanInput, CodeMapAnswer, type EngineId, type Finding, type JiraLink, PACKS, TERMINAL, type PackId, Plan, Scenario, type Criterion, FACTORY_DEFAULTS, SplitChild, coverageOf, criteriaOf, sizeLimits, type PlanRisk, type PlanStep, RUNNING, type Risk, TriageOutcome, WAITING_ON_USER, type Slots, type StageEngines, type StageRunCase, type Task, type TaskClassification, type TaskReports, type TaskRoute, type TaskSource, type CardSource, type TaskState, type TestCase, type VerifyReport, type EvidencePack, type TriageRecord, credentialOwner, maxRisk, reviseCriteria, stepOf, stepsOfAnswer, stronger, RUN_OR_GATE } from "@hardness/contracts";
import type { DataSource } from "typeorm";

import type { RestartPolicy } from "../config.ts";
import type { NewTaskRow, TaskChange, TaskStore } from "./task-store.ts";
import { PgTaskStore } from "../adapters/persistence/task-store.ts";
import type { ApprovalRow, Decision, EventRow, StageRunRow, TaskRow } from "../domain/task.ts";
import { ApproverRequiredError, IdempotencyConflictError, InvalidEscalationReasonError, NoEscalationToCorrectError, NoCasesToEditError, NoPlanToEditError, NoQuestionsToPostError, OutsideApproverRequiredError, PlanApprovedError, QuestionsCarrySecretError, RecordNotEditableError, RejectNotAllowedError, RepoPathLockedError, SameApproverError, SourceImmutableError, StageStartedError, TaskBusyError, TaskMovedError, TaskNotFoundError, runFacts, runSummary, sameSource, FindingNotFoundError, NoEvidenceError, NotReleaseOwnerError, WorktreeUnpushedError } from "../domain/task.ts";
import { type CardFields, type ContextMissing, type DedupContext, contextComplete } from "@hardness/contracts";
import { type ContextDeps, contextSetup, correctionsOf } from "./context-setup.ts";
import { type DedupAnswer, checkDuplicates } from "./intake-dedup.ts";
import type { Candidate } from "../domain/similarity.ts";
import { type DepFact, holdText, schedulable } from "../domain/stack.ts";
import { type CardFieldsInput, MAX_FOLLOWERS, MAX_LINKS, appendSource, cardFieldsOf, cardOf, channelOf, mergeFields, stackFieldsOf, unmergeFields, withDemand } from "../domain/card-fields.ts";
import { splitFacts } from "../domain/split.ts";
import { canSeeKept, contextAsk, mergedNotice, questionsComment } from "../domain/notices.ts";
import { triageVerdicts } from "../domain/triage-policy.ts";
import { packForState, packStates } from "../domain/packs.ts";
import { type PipelineEvent, type Step, TransitionError, transition } from "../domain/transition.ts";
import { isClone, unpushedCommits } from "../adapters/git/clone.ts";
import { branchDiffStat, removeWorktree as removeWorktreeOnDisk, revertCommit } from "../adapters/git/worktree.ts";
import { containerRunning, removeContainer } from "../adapters/docker/docker.ts";
import type { Credentials } from "../adapters/credentials/index.ts";
import { type RunSpan, type Telemetry, noTelemetry } from "./telemetry.ts";
import { type DecisionTruth, escalationResumedTruth, findingTruth, planTruth, sizeTruth, triageConfirmTruth, triageEditTruth, triageOutcomeTruth, worthLearningTruth } from "./decision-truth.ts";
import { fallbackCandidates } from "../domain/engine-choice.ts";
import type { EngineBudgetWatch } from "./engine-gates.ts";
import { pickEngine } from "./engine.ts";
import type { TaskUsage } from "./task-store.ts";
import { type CloseDeps, closeTask } from "./close-task.ts";
import { blockerSetKey } from "../domain/finding-sets.ts";
import { type RetroOutputs, acceptedMisses, appendAddedFinding, appendDismissedFinding, retroTruthOf, writeRetroTruth } from "./retro-outputs.ts";
import { EMITTABLE, type StageContext, type StageResult, type StageRunner } from "./ports.ts";
import { shippedEvent } from "./ship-loop.ts";
import { buildProgressOf, buildReportOf, prFactsOf, verifyReportOf } from "./reports.ts";
import { stageFactRows } from "./stage-facts.ts";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, normalize } from "node:path";

import type { Policy } from "../domain/policy.ts";
import { CONFIG_FILE, PolicyStore } from "./policy.ts";

import type { CommitFact, PriorityTruthEntry } from "./ground-truth.ts";
import { budgetRowsOf, buildBudget, rateLimitWaitMs } from "../domain/build-budget.ts";
import { DECIDED_REASONS, type DecidedEscalation, decideEscalation } from "./stages/escalation.ts";
import { type Economy, type Propose, noEconomy } from "./economy.ts";
import { type LoopStop, loopStop } from "../domain/economy/stop.ts";
import { type Decide } from "./stages/check-decide.ts";
import { withTask } from "./task-scope.ts";
import { buildEntryOf } from "../domain/build-entry.ts";
import { replanOf } from "../domain/replan.ts";
import { controlPlaneFiles } from "../domain/control-plane.ts";
import { type OwnersFound, type OwnersState, applyRiskOverride, approvalRule, outsideSatisfied, ownersStateOf, ruleFiles, sameName } from "../domain/approvers.ts";
import { bareLink } from "../domain/jira-link.ts";
import { findJiraKey, issueUrl } from "./jira.ts";

export { ApproverRequiredError, FindingNotFoundError, NoEvidenceError, IdempotencyConflictError, InvalidEscalationReasonError, NoEscalationToCorrectError, NoCasesToEditError, NoPlanToEditError, NoQuestionsToPostError, NotReleaseOwnerError, OutsideApproverRequiredError, PlanApprovedError, QuestionsCarrySecretError, RecordNotEditableError, RejectNotAllowedError, RepoPathLockedError, SameApproverError, SourceImmutableError, StageStartedError, TaskBusyError, TaskMovedError, TaskNotFoundError, WorktreeUnpushedError } from "../domain/task.ts";

/** A reset time as epoch seconds: the runner writes a number; older runners wrote a string (epoch or ISO). */
export function resetSeconds(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || value.trim() === "") return null;
  if (/^\d+(\.\d+)?$/.test(value.trim())) return Number(value);
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : Math.floor(parsed / 1000);
}

/** JSON with every object's keys sorted, so two bodies that differ only in key order hash alike. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v,
  );
}

/** The entry contract's fields a work order may carry; part of its hash only when it carries them, so a key stored before still matches. */
const CARD_ORDER_KEYS = ["sources", "reporter", "hints", "originMachine", "attachments", "project", "owners", "followers", "links"] as const;

/** A work order's hash: its fields with every default filled (`description: ""`, `criteria: []`,
 *  `repoPath: null`, `source: null`, `stages: {}`, a source's absent fields as null) and `start`
 *  left out, so an equivalent retry is the same order. */
export function orderHash(order: NewTask & Record<string, unknown>): string {
  const source = order.source ? Object.fromEntries(Object.entries(order.source).filter(([, value]) => value !== null && value !== undefined)) : null;
  const entry = Object.fromEntries(CARD_ORDER_KEYS.filter((key) => order[key] !== undefined).map((key) => [key, order[key]]));
  const canonical = {
    ...entry,
    title: order.title,
    description: order.description ?? "",
    criteria: order.criteria ?? [],
    repoPath: order.repoPath ?? null,
    source,
    stages: order.stages ?? {},
  };
  return createHash("sha256").update(canonicalJson(canonical)).digest("hex");
}

/** What a task snapshot says about its last stage run and its gate. */
export type TaskGlance = Pick<Task, "lastRun" | "gate">;

/** The card is not waiting at Intake's context gate, so there is nothing to give it. */
export class NoContextGateError extends Error {
  constructor(id: string, state: string) {
    super(`task ${id} is ${state}: it is not waiting for context`);
    this.name = "NoContextGateError";
  }
}

/** The gate was opened for one way of splitting (cards or tickets) and the approval would now do the other: the person read something else. */
export class SplitChangedError extends Error {
  constructor(id: string, was: string, now: string) {
    super(`task ${id}: the split was proposed to make ${was}, and an approval would now make ${now}: read it again`);
    this.name = "SplitChangedError";
  }
}

/** An automatic approval (a clock, a retry) reached a split gate: only a person's tap approves one. */
export class SplitAutoApprovalError extends Error {
  constructor(id: string) {
    super(`task ${id} waits at a split gate: only a person approves a split`);
    this.name = "SplitAutoApprovalError";
  }
}

/** A person approved a gate whose split does not pass the checks as they are now (or that carries none): send it back, reject it, or keep the card whole. */
export class SplitNotValidError extends Error {
  constructor(id: string) {
    super(`task ${id} has no valid split to approve: send it back with a comment, reject it, or keep the card whole`);
    this.name = "SplitNotValidError";
  }
}

/** The plan gate's two split outcomes: a proposal a person reads, or the reason there is none. */
/** A size bucket for a child's estimate, as a hint for triage (weighed, never trusted). */
const sizeBucketOf = (estLoc: number): string => (estLoc <= 100 ? "XS" : estLoc <= 400 ? "S" : estLoc <= 1000 ? "M" : estLoc <= 2000 ? "L" : "XL");

const isSplitOutcome = (outcome: unknown): outcome is "split" | "split_failed" => outcome === "split" || outcome === "split_failed";

/** What the duplicate check needs from outside: the one decision call, and the backlog (to list its items and to bump one). */
export interface DedupPort {
  decide(context: DedupContext): Promise<{ answer: DedupAnswer; recordId?: string }>;
  backlog?: { list(): Promise<Array<{ id: string; title: string; text: string; repo: string | null; sources: object[] }>>; bump(id: string): Promise<void>; unbump(id: string): Promise<void> };
}

/** A person's answer at the dedup gate named no listed candidate, or the wrong number of them. */
export class DedupAnswerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DedupAnswerError";
  }
}

/** A person named a repository the machine does not know (or not as an absolute, normalised path). */
export class UnknownRepositoryError extends Error {
  constructor(repoPath: string) {
    super(`the machine does not know a repository at ${JSON.stringify(repoPath.slice(0, 80))}: pick one it knows`);
    this.name = "UnknownRepositoryError";
  }
}

/** The states before Build: a card here has no workspace and no PR, so merging it loses nothing. */
const BEFORE_BUILD: ReadonlySet<TaskState> = new Set<TaskState>(["draft", "setup", "awaiting_setup", "triage", "awaiting_answers", "test_design", "awaiting_approval", "awaiting_test_check"]);

/** A merge or an undo the card's state does not allow. */
export class MergeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MergeError";
  }
}

export interface NewTask extends Omit<CardFieldsInput, "source"> {
  title: string;
  description?: string;
  criteria?: string[];
  repoPath?: string | null;
  source?: TaskSource | null;
  /** Defaults to `feature`. A PR task also names the PR's branch and its prepared worktree. */
  route?: TaskRoute;
  branch?: string | null;
  worktreePath?: string | null;
  /** The Jira issue to link from the start; absent, a key in the title or description links by itself. */
  jira?: JiraLink | null;
  /** A card made from a ticket is linked only to its own source: no Jira key is looked for in the text a stranger wrote. (`jira: null` means "not given", so it cannot say this.) */
  noJiraDetection?: boolean;
  /** The task's own engine per pack (the work order's `stages`); checked against the packs by the caller. */
  stages?: StageEngines;
  /** What triage_signals said about the issue, when intake ran it. */
  classification?: TaskClassification | null;
  record?: TriageRecord | null;
  evidence?: EvidencePack | null;
  /** The machine's alone (a split's approval sets it; `POST /tasks` has no such field): what stacks this card on others. */
  stack?: { audience?: ReturnType<typeof cardOf>["audience"]; splitFrom?: string; splitPart?: { n: number; of: number }; dependsOn?: string[]; startWhenReady?: boolean; riskFloor?: "low" | "medium" | "high" };
}

export interface PipelineOptions {
  /** A card that came from a ticket the tracker port knows is split into child tickets, never child cards (slice 11 wires it): `knows` answers where the card's ticket lives, `create` makes the children there once a person approved. */
  splitTickets?: {
    knows(task: TaskRow): Promise<{ tool: string; key: string } | null>;
    create(task: TaskRow, children: SplitChild[], gateId: string, floor: "low" | "medium" | "high"): Promise<{ keys: string[] }>;
  };
  /** Looks at an open release question (the ship approval) against GitHub: `merged` closes it as an automatic approval, `withdraw` takes it back so the watch asks again, `keep` leaves it. Nothing polls while a person is asked, so `tick` calls it at most once per `shipProbeMs`. */
  shipGateProbe?: (task: TaskRow, gate: ApprovalRow) => Promise<"merged" | "closed" | "withdraw" | "keep">;
  /** The shortest time between two probes of one card's release question (the repository's poll interval); 0 probes on every tick. */
  shipProbeMs?: number | null;
  /** Ends a card's kept sandbox (its extra folders) when the card is resumed or closed. Never throws into the pipeline. */
  releaseKept?: (taskId: string) => Promise<void>;
  /** Where each stage run is reported as a span; the no-op without a backend. */
  telemetry?: Telemetry;
  /** Called after each event is stored; the API streams these to the board. */
  onEvent?: (event: EventRow) => void;
  /** The Jira site (`https://acme.atlassian.net`): with it, a `PLAT-123` in a new ticket's text links the issue. Null: no detection. */
  jiraSite?: string | null;
  /** Writes what a person did after an escalation (the commits made on the branch since, names and counts) once they resume the card; answers the file's path. */
  escalationTruth?: (task: TaskRow, approval: ApprovalRow, commits: CommitFact[], corrected: string | null) => Promise<string>;
  /** The commits made on the branch after a time, with each file's name and line counts (no content). */
  commitsSince?: (worktreePath: string, sinceSha: string) => Promise<CommitFact[]>;
  /** The worktree's HEAD now: the escalated gate stores it, and what a person commits after it is ground truth. */
  headOf?: (worktreePath: string) => Promise<string>;
  /** Runs the `escalation_reason` decision on a Build escalation; its `decide` is bound late and read at call time (null: the agent's own word stands). */
  escalationDecide?: { decide: Decide | null };
  /** The token economy: folds each finished stage run into the repository's envelope and ledger; absent, nothing is kept. */
  economy?: Economy;
  /** Runs the fact_propose pack when a card closes; bound late (once PackRuns exists). Absent or null, no card asks for facts. */
  proposer?: { run: Propose | null };
  /** Whether the repo already has a luna.yaml; a task on one without runs setup first. Tests pass a fake. */
  hasConfig?: (repoPath: string) => boolean;
  /** Resolves a card's repository, project, owners and history by script when it starts; absent, a card starts as it is. */
  contextSetup?: ContextDeps;
  /** Intake's duplicate check; absent, no card is checked. */
  dedup?: DedupPort;
  /** The board's PUBLIC address (`MACHINE_PUBLIC_URL`), for the link a merged duplicate's source is given when its reporter may see the kept card; never the machine's own address. */
  publicBoardUrl?: string;
  /** The repositories the machine knows (the repository map, remembered checkouts): the only ones a person may give the context gate. Absent, none. */
  knownRepos?: () => Promise<string[]>;
  /** Writes the approved luna.yaml into the checkout. Tests pass a fake. */
  writeConfig?: (repoPath: string, text: string) => Promise<void>;
  /** Run stages inside the request instead of in the background. Tests use this. */
  inline?: boolean;
  /** Tasks that can be driving a stage at once, across every repo. The rest queue. */
  maxConcurrentTasks?: number;
  /** Running tasks one repo may hold at once; null or absent means no cap. */
  maxPerRepo?: number | null;
  /** Tasks that may drive one stage at once, e.g. `{ implementing: 2 }`; a stage not named has no cap. */
  maxPerStage?: Record<string, number>;
  /** Whether a stage container is still running at boot; tests pass a fake. */
  containerRunning?: (name: string) => Promise<boolean>;
  /** Stops and removes a container recover() decided not to re-attach to; tests pass a fake. */
  removeContainer?: (name: string) => Promise<void>;
  /** Undoes one commit in a worktree; tests pass a fake. */
  revertCommit?: (worktreePath: string, sha: string) => Promise<void>;
  /** The branch's diff against its base, for the card; tests pass a fake. */
  diffStat?: (worktreePath: string, repoPath: string | null) => Promise<{ added: number; removed: number } | null>;
  /** What the close step needs once a task is approved for good. Without it, nothing is closed on the host. */
  closeDeps?: CloseDeps;
  /** Where a merged card's retro leaves its outputs (decision 25): the truth file's directory, the machine's own facts, the graph's misses file and the Build Report's out-of-map files. */
  retroOutputs?: RetroOutputs;
  /** Who owns paths at the default branch, from CODEOWNERS (the code graph port's `owners`). The outside-approver rule reads only this, never a model's owners; absent, the rule is not enforced and says so. */
  owners?: (repoPath: string, paths: string[]) => Promise<Exclude<OwnersFound, "failed">>;
  /** Keeps the approved plan and what changed before it (ground truth); answers where. A failure is logged and never blocks the approval. */
  groundTruth?: (task: TaskRow, approval: ApprovalRow) => Promise<string>;
  /** False when the card's repository keeps no ground truth (`learning.truth: false`): no file is written for it. Absent, every card keeps it. */
  truthKept?: (task: TaskRow) => Promise<boolean>;
  /** Keeps a person's priority edit (levels and sub-scores) in `ground-truth/priority/`; absent, none is kept. */
  priorityTruth?: (entry: PriorityTruthEntry) => Promise<unknown>;
  /** Writes a person's thumbs on an Evidence Pack (`ground-truth/evidence/`); absent, the answer is only logged. */
  evidenceFeedback?: (task: TaskRow, pack: EvidencePack, feedback: { useful: boolean; note?: string | undefined }, at: Date) => Promise<string>;
  /** Writes onto a decision's record what a person's decision at a gate says about it (RFC 0005 wave 7). */
  truth?: DecisionTruth;
  /** Spend ceilings in USD; either unset means no ceiling of that kind. */
  budget?: Budget;
  /** On shutdown: `requeue` (default) parks running tasks for the next boot; `escalate` waits for you. */
  restartPolicy?: RestartPolicy;
  /** Each repo's luna.yaml (its monthly budget, auto-approval, concurrency); defaults when absent. */
  policies?: Pick<PolicyStore, "for">;
  /** Called once per threshold a scope crosses: 80, 90 and 100% of a task's, a repo's month's or the day's ceiling. */
  onAlert?: (alert: BudgetAlert) => void;
  /** The monthly caps per engine: told about every stage run with a cost, to raise their alerts. */
  engineBudgets?: Pick<EngineBudgetWatch, "afterRun">;
  /** Which engines this machine has a credential for: a queued task's next stage is held by the
   *  usage window of the engine it would really run on. Absent, every engine counts as available. */
  credentials?: Pick<Credentials, "check">;
}

export type { BudgetAlert } from "@hardness/contracts";

const ALERT_STEPS: ReadonlyArray<80 | 90 | 100> = [80, 90, 100];

export interface Budget {
  /** Per task, over all its stage runs. Over it, the task escalates before its next stage. */
  taskUsd?: number | null;
  /** Over the trailing 24 hours. Over it, nothing is claimed and running tasks park between stages. */
  dailyUsd?: number | null;
}

const DAY_MS = 24 * 60 * 60_000;
const usd = (value: number) => `$${value.toFixed(2)}`;
/** The first instant of the current calendar month, local time. */
const monthStart = (now = new Date()) => new Date(now.getFullYear(), now.getMonth(), 1);
/** `2026-10`, the repo-month alert key. */
const monthKey = (now = new Date()) => `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
const dayKey = (now = new Date()) => now.toISOString().slice(0, 10);

interface DecisionRecord {
  decision: Decision;
  reason?: string;
  response?: Record<string, unknown>;
}

/** Triage's archive reasons as the task's `ArchiveReason` keeps them (the set the board and the API pin). */
const TRIAGE_ARCHIVE: Record<string, ArchiveReason> = { duplicate: "duplicate", out_of_scope: "not_for_agent", not_actionable: "not_for_agent", stale: "rejected" };

interface Extra {
  /** Stage output to keep, e.g. triage questions shown at the next gate. */
  detail?: Record<string, unknown>;
  /** Your answer to the gate the task is waiting at. */
  decision?: DecisionRecord;
  /** States the task must still be in, checked under its row lock: a decision made on a listed row. */
  onlyFrom?: ReadonlySet<TaskState>;
  /** Checked under the row lock against the gate as it is now, before anything moves; throws to refuse. */
  guard?: (open: ApprovalRow | null) => Promise<void>;
}

/** A stage run a restart found still running in its container: drive it from where it is. */
interface Resume {
  runId: string;
  attempt: number;
  container: string;
  inputCommit: string | null;
  engine: EngineId | null;
}

/** Extra wait after a usage window's reset time before trying again. */
const RESUME_MARGIN_MS = 30_000;
/** A running task with no loop younger than this may be between its transition and its slot. */
const ORPHAN_GRACE_MS = 60_000;
/** How long abort() waits for the dying stage to let go of its slot before returning anyway. */
const ABORT_WIND_DOWN_MS = 15_000;
/** Identical consecutive failures of one stage before the stuck detector escalates. */
const STUCK_REPEATS = 3;
/** How long one rate-limit result holds its credential's claims when it names no reset time. */
const LATCH_FALLBACK_MS = 5 * 60_000;

/** Verifying's per-case verdicts from its detail (`cases: [{title, ok}]`), or null when it gave none. */
function casesOf(detail: Record<string, unknown> | undefined): StageRunCase[] | null {
  const cases = detail?.cases;
  if (!Array.isArray(cases)) return null;
  const rows = cases.flatMap((c) => {
    const row = c as { title?: unknown; ok?: unknown };
    return typeof row.title === "string" && typeof row.ok === "boolean" ? [{ title: row.title, ok: row.ok }] : [];
  });
  return rows.length > 0 ? rows : null;
}


/** Stages that only poll GitHub from the host: a restart runs them again. */
const HOST_POLLERS: ReadonlySet<TaskState> = new Set<TaskState>(["ci_watch", "awaiting_ship", "shipping"]);

const objectOf = (value: unknown): Record<string, unknown> | undefined => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined);

/** Coverage of a revised list of criteria by the scenarios on the gate: the stored report (the shape the plan stage writes), what is open, and the bar.
 *  Null for a gate with no scenarios. A scenario tied by id to a criterion the edit removed is named: it proves nothing now. */
function revisedCoverage(criteria: Criterion[], cases: unknown, previous: Record<string, unknown> | undefined, barOf: number | undefined) {
  if (!Array.isArray(cases) || cases.length === 0) return null;
  const scenarios = cases.flatMap((c) => {
    const parsed = Scenario.safeParse(c);
    return parsed.success ? [parsed.data] : [];
  });
  const untestable = (Array.isArray(previous?.untestable) ? previous.untestable.map(String) : []).filter((u) => criteria.some((c) => c.id === u));
  const report = coverageOf(criteria, scenarios, { untestable });
  const textOf = (id: string) => criteria.find((c) => c.id === id)?.text ?? id;
  const orphans = scenarios.filter((s) => s.criterion_ref && !criteria.some((c) => c.id === s.criterion_ref));
  const open = [
    ...report.gaps.filter((g) => !report.untestable.includes(g)).map((g) => `${g} has no scenario: ${textOf(g)}`),
    ...report.thin.map((g) => `${g} names a limit or an error and has no edge or failure scenario: ${textOf(g)}`),
    ...orphans.map((s) => `${s.id ?? s.title} is tied to ${s.criterion_ref}, which is no longer a criterion`),
  ];
  const bar = barOf ?? FACTORY_DEFAULTS.plan.coverage_score_min;
  return {
    report,
    bar,
    open,
    stored: { score: report.score, bar, gaps: report.gaps, thin: report.thin, untestable: report.untestable, open, per: report.per.map((p) => ({ id: p.criterion.id, text: p.criterion.text, scenarios: p.scenarios, types: p.types })) },
  };
}

/** The owners a code map names, as the gate keeps it; none for a gate with no map. */
function ownersOf(map: unknown): string[] {
  const owners = (map as { owners?: unknown } | null | undefined)?.owners;
  return Array.isArray(owners) ? owners.map(String) : [];
}

/** The gate's v2.2 Plan after a person's edit: the brief, criteria (ids kept), assumptions, rollback and steps follow, the version rises. */
function revisePlan(current: unknown, after: Record<string, unknown>, steps?: PlanStep[]): Plan | null {
  const parsed = Plan.safeParse(current);
  if (!parsed.success) return null;
  const plan = parsed.data;
  // The high-water mark of criterion numbers: a Plan written without one is read from the ids it has.
  const floor = plan.next_criterion ?? Math.max(0, ...plan.acceptance_criteria.map((c) => Number(/^C(\d+)$/.exec(c.id)?.[1] ?? 0)));
  const criteria = Array.isArray(after.criteria) ? reviseCriteria(plan.acceptance_criteria, after.criteria.map(String), floor) : plan.acceptance_criteria;
  return {
    ...plan,
    ...(typeof after.brief === "string" ? { goal: after.brief } : {}),
    ...(Array.isArray(after.criteria) ? { acceptance_criteria: criteria, next_criterion: Math.max(floor, ...criteria.map((c) => Number(/^C(\d+)$/.exec(c.id)?.[1] ?? 0))) } : {}),
    ...(Array.isArray(after.assumptions) ? { assumptions: after.assumptions.map(String) } : {}),
    ...(typeof after.rollback === "string" ? { rollback: after.rollback } : {}),
    ...(steps ? { steps: steps.map(stepOf) } : {}),
    version: plan.version + 1,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class Pipeline {
  private readonly store: TaskStore;
  private readonly onEvent: (event: EventRow) => void;
  private readonly hasConfig: (repoPath: string) => boolean;
  private readonly contextDeps: ContextDeps | null;
  private readonly dedupDeps: DedupPort | null;
  private readonly boardUrl: string | null;
  private readonly knownRepos: (() => Promise<string[]>) | null;
  private readonly escalationDecide: { decide: Decide | null };
  private readonly economy: Economy;
  private readonly proposer: { run: Propose | null } | undefined;
  private readonly escalationTruth: NonNullable<PipelineOptions["escalationTruth"]> | undefined;
  private readonly commitsSince: NonNullable<PipelineOptions["commitsSince"]> | undefined;
  private readonly headOf: PipelineOptions["headOf"];
  private readonly writeConfig: (repoPath: string, text: string) => Promise<void>;
  private readonly inline: boolean;
  private maxConcurrentTasks: number;
  /** Taking no new work: running stages finish, the queue waits. `drain()` / `resumeClaims()`. */
  private draining = false;
  private readonly maxPerRepo: number | null;
  private readonly maxPerStage: Record<string, number>;
  private readonly containerRunning: (name: string) => Promise<boolean>;
  private readonly removeContainer: (name: string) => Promise<void>;
  /** The stage each loop is driving right now, for the per-stage caps. */
  private readonly stages = new Map<string, TaskState>();
  /** Loops polling GitHub (ci_watch, and shipping while its monitor waits for a merge): they hold no slot, so the pool is free for work that computes. */
  private readonly offPool = new Set<string>();
  private readonly revertCommit: (worktreePath: string, sha: string) => Promise<void>;
  private readonly diffStat: (worktreePath: string, repoPath: string | null) => Promise<{ added: number; removed: number } | null>;
  private readonly closeDeps: CloseDeps | undefined;
  private readonly retroOutputs: RetroOutputs | undefined;
  private readonly releaseKept: ((taskId: string) => Promise<void>) | undefined;
  private readonly groundTruth: PipelineOptions["groundTruth"];
  private readonly truthKept: NonNullable<PipelineOptions["truthKept"]>;
  private readonly options_priorityTruth: PipelineOptions["priorityTruth"];
  private readonly evidenceFeedbackWriter: PipelineOptions["evidenceFeedback"];
  private readonly owners: PipelineOptions["owners"];
  private readonly truth: DecisionTruth | undefined;
  private readonly shipGateProbe: PipelineOptions["shipGateProbe"];
  private readonly shipProbeMs: number | null;
  readonly budget: Required<Budget>;
  private readonly restartPolicy: RestartPolicy;
  private readonly policies: Pick<PolicyStore, "for">;
  private readonly onAlert: (alert: BudgetAlert) => void;
  private readonly jiraSite: string | null;
  private readonly splitTickets: PipelineOptions["splitTickets"] | null;
  /** The highest threshold already raised per scope key (`task:<id>`, `repo:<path>:<month>`, `day:<date>`). */
  private readonly alerted = new Map<string, number>();
  /** Set by shutdown(): no slot is filled and no loop started from here on. */
  private stopping = false;
  /** The abort signal of each task currently driving a stage. Its size is the active count. */
  private readonly loops = new Map<string, AbortController>();
  private readonly resumeTimers = new Map<string, NodeJS.Timeout>();
  /** Per credential, the epoch ms until which queued work that would spend it is held: one usage
   *  window is shared by every stage on that credential, and by no other. */
  private readonly latches = new Map<CredentialOwner, number>();
  /** The credential whose window each paused task hit, so resuming it opens that window again. */
  private readonly pausedOn = new Map<string, CredentialOwner>();
  private readonly credentials: Pick<Credentials, "check">;
  private readonly engineBudgets: Pick<EngineBudgetWatch, "afterRun"> | null;
  private readonly telemetry: Telemetry;
  private supervisor: NodeJS.Timeout | undefined;

  constructor(
    db: DataSource,
    private readonly runnerFor: (stage: TaskState) => StageRunner,
    options: PipelineOptions = {},
  ) {
    this.store = new PgTaskStore(db);
    this.onEvent = options.onEvent ?? (() => {});
    this.escalationDecide = options.escalationDecide ?? { decide: null };
    this.economy = options.economy ?? noEconomy();
    this.proposer = options.proposer;
    this.escalationTruth = options.escalationTruth;
    this.commitsSince = options.commitsSince;
    this.headOf = options.headOf;
    this.contextDeps = options.contextSetup ?? null;
    this.dedupDeps = options.dedup ?? null;
    this.boardUrl = options.publicBoardUrl ?? null;
    this.knownRepos = options.knownRepos ?? null;
    this.hasConfig = options.hasConfig ?? ((repoPath) => existsSync(join(repoPath, CONFIG_FILE)));
    this.writeConfig = options.writeConfig ?? ((repoPath, text) => writeFile(join(repoPath, CONFIG_FILE), text));
    this.inline = options.inline ?? false;
    this.maxConcurrentTasks = options.maxConcurrentTasks ?? 4;
    this.maxPerRepo = options.maxPerRepo ?? null;
    this.maxPerStage = options.maxPerStage ?? {};
    this.containerRunning = options.containerRunning ?? containerRunning;
    this.removeContainer = options.removeContainer ?? removeContainer;
    this.revertCommit = options.revertCommit ?? revertCommit;
    this.diffStat = options.diffStat ?? branchDiffStat;
    this.closeDeps = options.closeDeps;
    this.retroOutputs = options.retroOutputs;
    this.releaseKept = options.releaseKept;
    this.groundTruth = options.groundTruth;
    this.options_priorityTruth = options.priorityTruth;
    this.truthKept = async (task) => (await options.truthKept?.(task).catch(() => true)) ?? true;
    this.evidenceFeedbackWriter = options.evidenceFeedback;
    this.owners = options.owners;
    this.truth = options.truth;
    this.shipGateProbe = options.shipGateProbe;
    this.shipProbeMs = options.shipProbeMs === undefined ? 0 : options.shipProbeMs;
    this.budget = { taskUsd: options.budget?.taskUsd ?? null, dailyUsd: options.budget?.dailyUsd ?? null };
    this.restartPolicy = options.restartPolicy ?? "requeue";
    this.policies = options.policies ?? new PolicyStore();
    this.onAlert = options.onAlert ?? (() => {});
    this.jiraSite = options.jiraSite ?? null;
    this.splitTickets = options.splitTickets ?? null;
    this.credentials = options.credentials ?? { check: () => Promise.resolve({ available: true }) };
    this.engineBudgets = options.engineBudgets ?? null;
    this.telemetry = options.telemetry ?? noTelemetry();
  }

  /** The repo's policy, from its luna.yaml. */
  policyFor(repoPath: string | null): Promise<Policy> {
    return this.policies.for(repoPath);
  }

  /** What the repo has spent this calendar month, in USD. */
  private repoSpentThisMonthUsd(repoPath: string): Promise<number> {
    return this.store.repoSpendSinceUsd(repoPath, monthStart());
  }

  /** The repos that cannot start a stage right now: over their PIPELINE.md monthly ceiling.
   *  Only repos with a queued task are looked at, so an idle repo costs no query. */
  private async reposOverMonth(): Promise<Set<string>> {
    const over = new Set<string>();
    const queued = (await this.store.listTasks()).filter((t) => t.queued && t.repoPath);
    for (const repo of new Set(queued.map((t) => t.repoPath!))) {
      const { monthlyBudgetUsd } = await this.policies.for(repo);
      if (monthlyBudgetUsd !== null && (await this.repoSpentThisMonthUsd(repo)) >= monthlyBudgetUsd) over.add(repo);
    }
    return over;
  }

  /** What the trailing 24 hours have cost, in USD. */
  spentTodayUsd(): Promise<number> {
    return this.store.spendSinceUsd(new Date(Date.now() - DAY_MS));
  }

  /** True while the day's spend sits at or over its ceiling: no new stage should start. */
  private async dayOver(): Promise<boolean> {
    if (this.budget.dailyUsd === null) return false;
    return (await this.spentTodayUsd()) >= this.budget.dailyUsd;
  }

  async createTask(input: NewTask): Promise<TaskRow> {
    const task = await this.store.createTask(this.newRow(input));
    await this.log(task.id, "task.created", { title: task.title, ...(input.route && input.route !== "feature" ? { route: input.route } : {}) });
    return this.get(task.id);
  }

  /** A work order under an `Idempotency-Key`: the first call makes the task, a retry with the same
   *  body answers that task (`created: false`), another body under the key is an `IdempotencyConflictError`
   *  naming the task. "The same body" is the same canonical order (`orderHash`); a key stored before
   *  bodies were canonical keeps its hash of the body as it was sent, which a retry still matches. */
  async createTaskOnce(order: NewTask & Record<string, unknown>, key: string): Promise<{ task: TaskRow; created: boolean }> {
    const hash = orderHash(order);
    const { task, created } = await this.store.createTaskOnce(this.newRow(order), key, hash);
    const legacy = () => createHash("sha256").update(canonicalJson(order)).digest("hex");
    if (task.requestHash !== hash && task.requestHash !== legacy()) throw new IdempotencyConflictError(key, task.id);
    if (created) await this.log(task.id, "task.created", { title: task.title });
    return { task: created ? await this.get(task.id) : task, created };
  }

  private newRow(input: NewTask): NewTaskRow {
    const source = input.source ?? null;
    return {
      title: input.title,
      description: input.description ?? "",
      criteria: input.criteria ?? [],
      repoPath: input.repoPath ?? null,
      source,
      ...(input.route ? { route: input.route } : {}),
      ...(input.branch !== undefined ? { branch: input.branch } : {}),
      ...(input.worktreePath !== undefined ? { worktreePath: input.worktreePath } : {}),
      jira: input.jira ?? this.detectJira(input.title, input.description ?? "", source, input.noJiraDetection !== true),
      ...(input.stages ? { stages: input.stages } : {}),
      ...(input.classification ? { classification: input.classification } : {}),
      ...(input.record ? { record: input.record } : {}),
      ...(input.evidence ? { evidence: input.evidence } : {}),
      card: { ...cardFieldsOf({ ...input, source }), ...stackFieldsOf(input.stack, new Date().toISOString()) },
    };
  }

  /** The link a new ticket starts with: its intake source's issue, else the first key in its text when Jira is set up. A notch ticket gets none. */
  private detectJira(title: string, description: string, source: TaskSource | null, detect = true): JiraLink | null {
    if (source?.kind === "jira") return bareLink(source.key, source.url, source.issueType);
    if (!detect) return null;
    if (!this.jiraSite || source?.kind === "notch") return null;
    const key = findJiraKey(title) ?? findJiraKey(description);
    return key ? bareLink(key, issueUrl(this.jiraSite, key)) : null;
  }

  /** The decision's ground truth for a merge or its undo, when the card was judged by `intake_dedup`. Never throws. */
  private async dedupTruth(task: TaskRow, keptId: string, choice: "same" | "different", source: string): Promise<void> {
    const dedup = cardOf(task).dedup;
    const slot = dedup?.candidates.find((c) => c.id === keptId)?.slot;
    if (!dedup?.recordId || slot === undefined || !this.truth) return;
    await this.truth.learned({ pack: "intake_dedup", recordId: dedup.recordId, label: { [`slot${slot}`]: { choice } }, kind: "person", source, taskId: task.id }).catch(() => false);
  }

  /** `dupId` is a report of `keptId`: its source joins the kept card, its reporter follows it, the demand goes up and the priority is scored again.
   *  The duplicate is archived as a duplicate, and its source is told, in fixed words, which card tracks it. */
  async merge(dupId: string, keptId: string, by: "person" | "machine" = "person", decision?: DecisionRecord): Promise<TaskRow> {
    if (dupId === keptId) throw new MergeError("a card cannot be merged into itself");
    const dup = await this.get(dupId);
    const kept = await this.get(keptId);
    if (TERMINAL.has(dup.state)) throw new MergeError(`card ${dupId} has ended: nothing to merge`);
    if (TERMINAL.has(kept.state)) throw new MergeError(`card ${keptId} has ended: nothing to merge into`);
    if (!BEFORE_BUILD.has(dup.state) || dup.worktreePath || dup.branch) throw new MergeError(`card ${dupId} has reached Build (a workspace or a PR may exist): it cannot be merged`);
    const scoring = (await this.policyFor(kept.repoPath)).factory.scoring;
    // The kept card is read again under its row lock and written in the same transaction: two duplicates merging into it at once each add their own
    // source, follower and demand to what the other left, never to the row both read before either wrote.
    await this.store.withTaskLock(keptId, async (locked, tx) => {
      if (TERMINAL.has(locked.state)) throw new MergeError(`card ${keptId} has ended: nothing to merge into`);
      if ((cardOf(locked).merged ?? []).some((m) => m.id === dupId)) return;
      const mergedCard = mergeFields(cardOf(locked), cardOf(dup), dupId);
      await tx.updateTask(keptId, { card: mergedCard, record: withDemand(locked.record ?? null, mergedCard.demand ?? 1, scoring) });
    });
    await this.log(keptId, "card.merged", { from: dupId });
    await this.log(dupId, "card.merged", { into: keptId });
    const dupView = { repoPath: dup.repoPath, sources: cardOf(dup).sources };
    const seen = canSeeKept(dupView, { repoPath: kept.repoPath, sources: cardOf(kept).sources });
    await this.log(dupId, "task.reply", { body: mergedNotice(seen ? keptId : null, seen && this.boardUrl ? `${this.boardUrl}/tasks/${keptId}` : null), secret: false, by: "machine", kind: "merged" });
    if (by === "person") await this.dedupTruth(dup, keptId, "same", "merge_confirmed");
    return this.closeAsMerged(dupId, keptId, decision);
  }

  /** Undoes a merge: the kept card gives back the source, the followers and the demand, and the duplicate becomes a new card. */
  async unmerge(dupId: string): Promise<TaskRow> {
    const dup = await this.get(dupId);
    const events = await this.events(dupId);
    const merged = events.findLast((e) => e.kind === "card.merged" && typeof e.payload.into === "string");
    const undone = events.findLast((e) => e.kind === "card.unmerged");
    if (!merged || (undone && Number(undone.id) > Number(merged.id))) throw new MergeError(`card ${dupId} is not a merged duplicate`);
    const keptId = String(merged.payload.into);
    const kept = await this.store.getTask(keptId);
    const card = cardOf(dup);
    if (kept) {
      const scoring = (await this.policyFor(kept.repoPath)).factory.scoring;
      await this.store.withTaskLock(keptId, async (locked, tx) => {
        const back = unmergeFields(cardOf(locked), dupId);
        await tx.updateTask(keptId, { card: back, record: withDemand(locked.record ?? null, back.demand ?? 1, scoring) });
      });
    }
    if (merged.payload.backlog === true) await this.dedupDeps?.backlog?.unbump(keptId).catch(() => undefined);
    const restored = await this.createTask({
      title: dup.title,
      description: dup.description,
      criteria: dup.criteria,
      repoPath: dup.repoPath,
      source: dup.source,
      sources: card.sources,
      ...(card.reporter ? { reporter: card.reporter } : {}),
      ...(card.hints ? { hints: card.hints } : {}),
      attachments: card.attachments,
      ...(card.project ? { project: card.project } : {}),
      owners: card.owners,
      followers: card.followers,
      links: card.links,
    });
    // The person said these are not the same: the new card carries that, is linked to the card it was taken from, and is not checked again.
    const decided = { at: new Date().toISOString(), recordId: null, candidates: [], answer: null, outcome: "none" as const, chosen: "neither" as const };
    await this.store.updateTask(restored.id, { card: { ...cardOf(restored), dedup: decided, ...(kept ? { related: [keptId] } : {}) } });
    if (kept) {
      const theirs = cardOf(await this.get(keptId));
      await this.store.updateTask(keptId, { card: { ...theirs, related: [...new Set([...(theirs.related ?? []), restored.id])].slice(0, 20) } });
      await this.log(keptId, "card.unmerged", { restored: restored.id, from: dupId });
    }
    await this.log(dupId, "card.unmerged", { restored: restored.id });
    await this.dedupTruth(dup, keptId, "different", "merge_undone");
    return this.get(restored.id);
  }

  /** Adds a report of the same card (a merged duplicate) after its sources. The first source never changes. */
  async addSource(id: string, source: TaskSource | CardSource): Promise<TaskRow> {
    const task = await this.get(id);
    const card = cardOf(task);
    await this.store.updateTask(id, { card: { ...card, sources: appendSource(card.sources, source) } });
    return this.get(id);
  }

  /**
   * A Slack thread about this card: its permalink goes into `links` (key `slack:<channel>:<root ts>`) and its author into `followers`. It is never added to
   * `sources`: that would change who can see the card and where it posts. Answers the card's priority when its record has one. Logs ids only.
   */
  async attachThread(id: string, thread: { channel: string; ts: string; permalink: string; authorId: string }): Promise<{ priority: "P0" | "P1" | "P2" | "P3" | null }> {
    const task = await this.get(id);
    const card = cardOf(task);
    const key = `slack:${thread.channel}:${thread.ts}`;
    const links = key in card.links || Object.keys(card.links).length >= MAX_LINKS ? card.links : { ...card.links, [key]: thread.permalink.slice(0, 2000) };
    const author = thread.authorId.replace(/[^\p{L}\p{N}@/._-]/gu, "").slice(0, 120);
    const followers = !author || card.followers.includes(author) || card.followers.length >= MAX_FOLLOWERS ? card.followers : [...card.followers, author];
    await this.store.updateTask(id, { card: { ...card, links, followers } });
    await this.log(id, "conversation.attached", { channel: thread.channel, ts: thread.ts });
    const priority = (task.record as { urgencyDetail?: { priority?: string } } | null)?.urgencyDetail?.priority;
    return { priority: priority === "P0" || priority === "P1" || priority === "P2" || priority === "P3" ? priority : null };
  }

  /** The address of the card's PR, as soon as a stage that opened or watched it finished (where the board and Jira sync read it): the latest finish that names one. Only a web address; null otherwise. */
  async prLinkOf(id: string): Promise<string | null> {
    for (const e of (await this.events(id)).filter((x) => x.kind === "stage.finished").reverse()) {
      const url = (e.payload.detail as { prUrl?: unknown } | undefined)?.prUrl;
      if (typeof url === "string" && /^https:\/\/[^\s]+$/.test(url)) return url;
    }
    return null;
  }

  /** The latest task linked to a Jira issue, by its link or its intake source, if any. */
  findByJiraKey(key: string): Promise<TaskRow | null> {
    return this.store.findTaskByJiraKey(key);
  }

  /** Replaces the task's Jira link (null unlinks). The caller logs why. */
  async setJira(id: string, jira: JiraLink | null): Promise<TaskRow> {
    await this.get(id);
    await this.store.updateTask(id, { jira });
    return this.get(id);
  }

  /** `:setup <repo>`: a setup-only task for the checkout, started at once. Its one gate is the
   *  proposed luna.yaml; approving writes the file and closes the task. */
  async setupRepo(repoPath: string): Promise<TaskRow> {
    const task = await this.createTask({
      title: `Set up ${basename(repoPath)}`,
      description: `Propose the ${CONFIG_FILE} for ${repoPath}: its checks, the services its code needs, its toolchains and policy.`,
      repoPath,
      route: "setup",
    });
    return this.dispatch(task.id, { type: "start", setup: true });
  }

  /** Stage slots: how many tasks may drive a stage at once, how many do right now, whether the
   *  machine is draining (finishing what runs, claiming nothing new), and which credentials'
   *  usage windows hold their queued work, until when. */
  get slots(): Required<Slots> {
    const latched = this.openLatches().map(([owner, until]) => ({ owner, until: new Date(until).toISOString() }));
    return { max: this.maxConcurrentTasks, active: this.active(), draining: this.draining, latched };
  }

  /** Loops holding a slot: every stage loop but the ones polling ci_watch. */
  private active(): number {
    return this.loops.size - this.offPool.size;
  }

  /** True when `stage` already has its cap's worth of loops driving it (`id` itself not counted). */
  private stageAtCap(stage: TaskState, id: string): boolean {
    const cap = this.maxPerStage[stage];
    if (cap === undefined) return false;
    let held = 0;
    for (const [other, s] of this.stages) if (other !== id && s === stage && this.loops.has(other)) held++;
    return held >= cap;
  }

  /** "Stop picking up work, I'm leaving": running stages finish, queued tasks wait. */
  drain(): Required<Slots> {
    this.draining = true;
    return this.slots;
  }

  /** Back to normal: the queue is picked up again at once. */
  resumeClaims(): Required<Slots> {
    this.draining = false;
    void this.fillSlots().catch((error: unknown) => console.error("could not fill slots after resume", error));
    return this.slots;
  }

  /** Resizes the pool at run time; a bigger one fills from the queue at once, a smaller one
   *  lets running stages finish and claims nothing until the count fits. */
  setSlots(max: number): Required<Slots> {
    if (!Number.isInteger(max) || max < 1) throw new Error(`slots must be at least 1, got ${max}`);
    this.maxConcurrentTasks = max;
    void this.fillSlots().catch((error: unknown) => console.error("could not fill slots after resize", error));
    return this.slots;
  }

  activeCount(): number {
    return this.active();
  }

  list(): Promise<TaskRow[]> {
    return this.store.listTasks();
  }

  /** Spend and worked time per task for every task that has a run, in one query. */
  usageByTask(): Promise<Map<string, TaskUsage>> {
    return this.store.usageByTask();
  }

  /** What one task has spent, and how long its runs took. */
  /** Each task's `lastRun` and `gate`, for its snapshot; two queries for a whole list. */
  async glances(ids: readonly string[]): Promise<Map<string, TaskGlance>> {
    const { runs, gates } = await this.store.glanceRows(ids);
    const out = new Map<string, TaskGlance>(ids.map((id) => [id, { lastRun: null, gate: null }]));
    for (const run of runs) {
      out.get(run.taskId)!.lastRun = { stage: run.stage, engine: run.engine, outcome: run.outcome ?? run.status, summary: runSummary(run.finished), at: run.endedAt.toISOString() };
    }
    for (const gate of gates) out.get(gate.taskId)!.gate = { state: gate.kind, requested: gate.requested };
    return out;
  }

  async glance(id: string): Promise<TaskGlance> {
    return (await this.glances([id])).get(id)!;
  }

  taskUsage(id: string): Promise<TaskUsage> {
    return this.store.taskUsage(id);
  }

  /** A person says whether the card's Evidence Pack was useful. A card with no pack is refused. The answer is a file for the retro and a row with ids and enums only (no `stage.` prefix: no container can write that kind). */
  /** The finding ids the last Verify reported (its classified rows and findings). */
  private async reportedFindings(id: string): Promise<Map<string, string | null>> {
    const detail = (await this.latestStageFinish(id, "verifying"))?.detail;
    const found = new Map<string, string | null>();
    for (const row of Array.isArray(detail?.findings) ? (detail!.findings as Array<{ id?: unknown }>) : []) if (typeof row?.id === "string" && row.id) found.set(row.id, null);
    for (const row of Array.isArray(detail?.classified) ? (detail!.classified as Array<{ id?: unknown; recordId?: unknown }>) : []) if (typeof row?.id === "string" && row.id) found.set(row.id, typeof row.recordId === "string" ? row.recordId : null);
    return found;
  }

  /** A person dismisses a finding while the card waits at awaiting_ship: `finding.dismissed` carries the id only and the reason a person typed goes to the ground truth file (`safe()`, capped), never the stream; when Verify kept a classification record for it, the truth is "nit" (`ship_dismissed`). */
  async dismissFinding(id: string, findingId: string, reason?: string): Promise<void> {
    const task = await this.get(id);
    if (task.state !== "awaiting_ship") throw new TransitionError(task, { type: "approved" });
    const reported = await this.reportedFindings(id);
    if (!reported.has(findingId)) throw new FindingNotFoundError(findingId);
    await this.log(id, "finding.dismissed", { id: findingId });
    if (this.retroOutputs) await appendDismissedFinding(this.retroOutputs.stateDir, id, { id: findingId, reason });
    const recordId = reported.get(findingId);
    if (recordId) await this.truth?.learned({ pack: "finding_classify", recordId, label: { severity: { choice: "nit" } }, kind: "person", source: "ship_dismissed", taskId: id });
  }

  /** A person adds a finding Verify missed: the row holds the severity only; the text goes to the ground truth file. */
  async addFinding(id: string, finding: { title: string; severity: "blocker" | "should_fix" | "nit"; path?: string | undefined; line?: number | undefined }): Promise<void> {
    const task = await this.get(id);
    if (task.state !== "awaiting_ship") throw new TransitionError(task, { type: "approved" });
    if (this.retroOutputs && (await this.truthKept(task))) await appendAddedFinding(this.retroOutputs.stateDir, id, finding);
    await this.log(id, "finding.added", { severity: finding.severity });
  }

  async evidenceFeedback(id: string, feedback: { useful: boolean; note?: string | undefined }): Promise<void> {
    const task = await this.get(id);
    if (!task.evidence) throw new NoEvidenceError(id);
    if (await this.truthKept(task)) await this.evidenceFeedbackWriter?.(task, task.evidence, feedback, new Date());
    await this.log(id, "evidence.feedback", { useful: feedback.useful, format: task.evidence.format, sha: task.evidence.commitSha.slice(0, 7) });
  }

  async get(id: string): Promise<TaskRow> {
    const task = await this.store.getTask(id);
    if (!task) throw new TaskNotFoundError(id);
    return task;
  }

  /** Logs a fact about a task from outside the engine (e.g. the thread it is reported in). */
  record(taskId: string, kind: string, payload: Record<string, unknown>): Promise<void> {
    return this.log(taskId, kind, payload);
  }

  /** The task created from this external issue (or, with `github_pr`, the latest from this PR), if any. */
  findBySource(repo: string, number: number, kind: "github" | "github_pr" = "github"): Promise<TaskRow | null> {
    return this.store.findTaskBySource(repo, number, kind);
  }

  /** Edits the ticket's text. Stages started after this see the new text. The source never
   *  changes (the same one again is no change), and the checkout only until a worktree or branch
   *  was made from it. */
  async update(
    id: string,
    patch: { title?: string; description?: string; criteria?: string[]; repoPath?: string | null;
      source?: TaskSource | null;
    },
  ): Promise<TaskRow> {
    const fields = await this.store.withTaskLock(id, async (task, tx) => {
      const { source, ...rest } = patch;
      if (source !== undefined && !sameSource(source, task.source)) throw new SourceImmutableError(id);
      const moved = rest.repoPath !== undefined && rest.repoPath !== task.repoPath;
      if (moved && (task.worktreePath || task.branch)) throw new RepoPathLockedError(id, task.branch);
      const changes = Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined));
      if (Object.keys(changes).length > 0) await tx.updateTask(id, changes);
      return Object.keys(changes);
    });
    if (fields.length > 0) await this.log(id, "task.edited", { fields });
    const after = await this.get(id);
    const resolved = after.card?.resolved;
    if (resolved && patch.repoPath !== undefined) {
      const corrections = correctionsOf(resolved, { repoPath: after.repoPath, project: resolved.project });
      if (corrections.length > 0) await this.log(id, "context.corrected", { corrections });
    }
    return after;
  }

  /** Edits triage's plan while it awaits your approval, or at the test check (the plan is
   *  approved then, but nothing is built yet, so the latest plan approval still moves). Only the
   *  fields given change; the rest (including slices) stay as triage wrote them. Each edit is
   *  kept as a revision on the approval and logged as `plan.edited`. */
  async editPlan(id: string, patch: EditPlanInput): Promise<TaskRow> {
    const taskRepo = (await this.get(id)).repoPath;
    const planPolicy = (await this.policyFor(taskRepo)).factory.plan;
    const approvers = planPolicy.approvers;
    const { fields, gate } = await this.store.withTaskLock(id, async (task, tx) => {
      const open = await tx.findOpenApproval(id);
      let plan: ApprovalRow | undefined;
      if (open?.kind === "awaiting_approval") plan = open;
      else if (open?.kind === "awaiting_test_check") {
        plan = (await tx.listApprovals(id)).findLast((a) => a.kind === "awaiting_approval" && a.decision === "approved");
      }
      if (!open || !plan || isSplitOutcome(plan.requested.outcome)) throw new NoPlanToEditError(id);
      // What Build may touch is not edited once two names (or one) approved it: only the text beside it moves.
      if (plan.decision === "approved" && (patch.steps !== undefined || patch.risk !== undefined || patch.map !== undefined || patch.rollback !== undefined)) throw new PlanApprovedError(id);
      const requested = plan.requested;
      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};
      const change = (field: string, value: unknown) => {
        if (JSON.stringify(value) === JSON.stringify(requested[field])) return false;
        if (requested[field] !== undefined) before[field] = requested[field];
        after[field] = value;
        return true;
      };
      for (const field of ["brief", "criteria", "assumptions", "rollback"] as const) if (patch[field] !== undefined) change(field, patch[field]);
      // Steps: the slices Build, the designer and the scope check read follow them.
      const stepped = patch.steps ? stepsOfAnswer(patch.steps) : null;
      if (stepped) change("slices", stepped.slices);
      // The risk: the machine's level is a floor. A higher level applies at once; a lower one is kept with its reason and shown.
      const overrides: Record<string, unknown> = { ...(objectOf(requested.overrides) ?? {}) };
      if (patch.risk) {
        const current = (objectOf(requested.risk) ?? { level: "low" }) as PlanRisk & { machine?: Risk };
        const applied = applyRiskOverride(current, patch.risk);
        const moved = change("risk", applied.risk);
        if (moved || JSON.stringify(overrides.risk) !== JSON.stringify(applied.override)) overrides.risk = applied.override;
      }
      // Steps that touch the control plane (CI, ownership, luna.yaml, a lockfile) make the plan high risk, as at the plan stage: the machine's floor rises
      // with them, so the approvers rule and Ship read the high level and a person's lower override is shown, not applied.
      let riskRaised: string | undefined;
      const control = stepped ? controlPlaneFiles(stepped.steps.flatMap((step) => [...(step.files ?? []), ...(step.touchpoints ?? [])])) : [];
      if (control.length > 0) {
        const now = (after.risk as (PlanRisk & { machine?: Risk }) | undefined) ?? (objectOf(requested.risk) ?? { level: "low" }) as PlanRisk & { machine?: Risk };
        if (now.level !== "high" || now.machine !== "high") {
          change("risk", { ...now, level: "high", machine: "high" });
          if (overrides.risk !== undefined) overrides.risk = { ...(objectOf(overrides.risk) ?? {}), applied: false };
          riskRaised = `a step touches a control-plane file: ${control.slice(0, 5).join(", ")}`;
        }
      }
      if (patch.map) {
        const { reason, ...fixes } = patch.map;
        const current = (objectOf(requested.map) ?? { components: [], files: [], entry_points: [], owners: [], confidence: 0 }) as Record<string, unknown>;
        if (change("map", { ...current, ...fixes })) overrides.map = { reason };
      }
      const fields = Object.keys(after);
      if (fields.length > 0) {
        const revisions = Array.isArray(requested.revisions) ? requested.revisions : [];
        // The v2.2 Plan follows the edit and its version rises (a gate from before the Plan has none).
        const revised = revisePlan(requested.plan, after, stepped?.steps);
        // A new list of criteria is new ids: coverage by id is recomputed against the scenarios the designer left, and what is open is stored and flagged.
        const covered = Array.isArray(after.criteria) ? revisedCoverage(revised?.acceptance_criteria ?? criteriaOf(after.criteria.map(String)), requested.cases, objectOf(requested.coverageReport), planPolicy.coverage_score_min) : null;
        const flaggedNow = Array.isArray(requested.flagged) ? requested.flagged.map(String) : [];
        const flagged = covered ? [...flaggedNow.filter((f) => f !== "coverage"), ...(covered.open.length > 0 || covered.report.score < covered.bar ? ["coverage"] : [])] : flaggedNow;
        const level = (after.risk as PlanRisk | undefined)?.level ?? (objectOf(requested.risk)?.level as Risk | undefined) ?? "low";
        const gateNow = { ...requested, ...after, plan: revised ?? requested.plan, slices: after.slices ?? requested.slices };
        const ownersNow: OwnersState = level === "high" ? await this.ruleOwnersOf(taskRepo, gateNow) : { state: "skipped" };
        // A changed plan is a new plan: whoever approved the old one has not approved this one.
        await tx.updateApprovalRequested(plan, {
          ...requested,
          ...after,
          ...(revised ? { plan: revised } : {}),
          ...(covered ? { coverageReport: covered.stored, flagged } : {}),
          ...(Object.keys(overrides).length > 0 ? { overrides } : {}),
          ...(riskRaised ? { riskRaised } : {}),
          ...("risk" in after || "map" in after || requested.approvalRule !== undefined ? { approvalRule: approvalRule(level === "high" || level === "medium" ? level : "low", approvers, ownersNow) } : {}),
          ...(level === "high" && ("risk" in after || "map" in after || "slices" in after || requested.ruleOwners !== undefined) ? { ruleOwners: ownersNow } : {}),
          ...(Array.isArray(requested.approvers) ? { approvers: [] } : {}),
          revisions: [...revisions, { at: new Date().toISOString(), before, after }],
        });
        // Approving the plan adopted its criteria onto the ticket; an edit after that follows them.
        if (plan.decision === "approved" && Array.isArray(after.criteria) && after.criteria.length > 0) {
          await tx.updateTask(id, { criteria: after.criteria.map(String) });
        }
      }
      return { fields, gate: open.kind };
    });
    if (fields.length > 0) await this.log(id, "plan.edited", { fields, gate });
    return this.get(id);
  }

  /** A person's correction of the Triage Record while the card waits at a gate. The record's version rises and the corrected fields are the
   *  person's (`decisionBy: person`, `editedFields`); each correction is ground truth for the `triage_signals` reading that said otherwise. */
  async editRecord(id: string, patch: { kind?: string; typeOfWork?: string; size?: string; riskPrelim?: string; priority?: string }): Promise<TaskRow> {
    const taskRepo = (await this.get(id)).repoPath;
    const approvers = (await this.policyFor(taskRepo)).factory.plan.approvers;
    const priorityBefore: { seen?: boolean; level?: string | null; subScores?: Record<string, unknown> | null } = {};
    const { record, classification, fields } = await this.store.withTaskLock(id, async (task, tx) => {
      if (!task.record) throw new RecordNotEditableError(id, "triage has not written one");
      if (task.state !== "awaiting_answers" && task.state !== "awaiting_approval") throw new RecordNotEditableError(id, `the card is ${task.state}: a record is corrected at triage's questions or at the plan gate`);
      const before = task.record;
      const next: Record<string, unknown> = { ...before };
      const changed: Array<NonNullable<TriageRecord["editedFields"]>[number]> = [];
      const set = (field: (typeof changed)[number], current: unknown, value: string | undefined, apply: () => void) => {
        if (value === undefined || value === current) return;
        apply();
        changed.push(field);
      };
      set("kind", before.kind, patch.kind, () => (next.kind = patch.kind));
      set("typeOfWork", before.typeOfWork, patch.typeOfWork, () => (next.typeOfWork = patch.typeOfWork));
      set("size", before.size, patch.size, () => (next.size = patch.size));
      set("riskPrelim", before.riskPrelim, patch.riskPrelim, () => {
        // The machine's own grade stays the floor: a person's lower value is kept and shown, but `risk` (what the plan's floor and the
        // approver and ship rules read) is the higher of the two; a higher value applies at once.
        const order = ["low", "medium", "high"];
        const floor = before.riskMachine ?? before.riskPrelim ?? "low";
        next.riskMachine = floor;
        next.riskPrelim = patch.riskPrelim;
        next.risk = order.indexOf(patch.riskPrelim!) >= order.indexOf(floor) ? patch.riskPrelim : floor;
      });
      set("priority", before.urgencyDetail?.priority, patch.priority, () => {
        Object.assign(priorityBefore, { seen: true, level: before.urgencyDetail?.priority ?? null, subScores: (before.urgencyDetail?.subScores as Record<string, unknown> | undefined) ?? null });
        next.urgency = patch.priority;
        next.urgencyDetail = { subScores: { who: 2, what: 2, impact: 2, time: 2, demand: 2 }, ...before.urgencyDetail, priority: patch.priority };
      });
      if (changed.length === 0) return { record: before, classification: task.classification, fields: [] as typeof changed };
      next.version = (before.version ?? 1) + 1;
      next.decisionBy = "person";
      next.editedFields = [...new Set([...(before.editedFields ?? []), ...changed])];
      await tx.updateTask(id, { record: next as TriageRecord });
      // A risk raised here reaches the open plan gate in the same transaction: its grade rises, and approvals given for the lower one are void.
      const gate = await tx.findOpenApproval(id);
      const gateRisk = gate?.requested.risk as { level?: unknown } | undefined;
      if (gate && gate.kind === "awaiting_approval" && gate.requested.outcome === undefined && gateRisk && typeof next.risk === "string") {
        const level = maxRisk(next.risk as Risk, (typeof gateRisk.level === "string" ? gateRisk.level : "none") as Risk);
        if (level !== gateRisk.level) {
          // The approvers rule and the owners it reads follow the new level, as `editPlan` computes them: High needs the repo's names for high
          // (two by default) and the owners CODEOWNERS names for the plan's files.
          const gateNow = { ...gate.requested, risk: { ...gateRisk, level } };
          const ownersNow: OwnersState = level === "high" ? await this.ruleOwnersOf(taskRepo, gateNow) : { state: "skipped" };
          await tx.updateApprovalRequested(gate, {
            ...gateNow,
            approvalRule: approvalRule(level === "high" || level === "medium" ? level : "low", approvers, ownersNow),
            ...(level === "high" ? { ruleOwners: ownersNow } : {}),
            ...(Array.isArray(gate.requested.approvers) ? { approvers: [] } : {}),
          });
        }
      }
      return { record: next as TriageRecord, classification: task.classification, fields: changed };
    });
    if (fields.length > 0) {
      await this.log(id, "record.edited", { fields, version: record.version ?? null });
      const recordId = classification?.recordId;
      if (priorityBefore.seen && patch.priority && this.options_priorityTruth && (await this.truthKept(await this.get(id)))) {
        await this.options_priorityTruth({ machine: "triage", id, recordId: classification?.recordId ?? null, subScores: priorityBefore.subScores ?? null, machineLevel: priorityBefore.level ?? null, personLevel: patch.priority }).catch(() => {});
      }
      const label = triageEditTruth({ ...record, editedFields: fields });
      if (this.truth && recordId && Object.keys(label).length > 0) await this.truth.learned({ pack: "triage_signals", recordId, label, kind: "person", source: "record_edit", taskId: id });
    }
    return this.get(id);
  }

  /** Replaces the scenarios on the open gate that carries them (the plan gate, or a legacy test check); everything else on the gate stays. */
  async editCases(id: string, cases: TestCase[]): Promise<TaskRow> {
    await this.store.withTaskLock(id, async (_task, tx) => {
      const open = await tx.findOpenApproval(id);
      const carriesCases = open?.kind === "awaiting_test_check" || (open?.kind === "awaiting_approval" && !isSplitOutcome(open.requested.outcome) && Array.isArray(open.requested.cases));
      if (!open || !carriesCases) throw new NoCasesToEditError(id);
      // Kept as a revision like a plan edit, so ground truth can tell the proposed scenarios from the approved ones.
      const revisions = Array.isArray(open.requested.revisions) ? open.requested.revisions : [];
      const before = open.requested.cases === undefined ? {} : { cases: open.requested.cases };
      await tx.updateApprovalRequested(open, { ...open.requested, cases, ...(Array.isArray(open.requested.approvers) ? { approvers: [] } : {}), revisions: [...revisions, { at: new Date().toISOString(), before, after: { cases } }] });
    });
    await this.log(id, "cases.edited", { count: cases.length });
    return this.get(id);
  }

  /** Sets the task's engine for each pack named (null clears it, back to luna.yaml's or the pack's
   *  default). A pack whose stage has run or is running on the task keeps its engine: the whole
   *  change is refused with `StageStartedError`. The caller checks the engines against the packs. */
  async setStages(id: string, change: Partial<Record<PackId, EngineId | null>>): Promise<TaskRow> {
    await this.store.withTaskLock(id, async (task, tx) => {
      const ran = new Set<string>((await tx.listStageRuns(id)).map((run) => run.stage));
      const packs = Object.keys(change) as PackId[];
      const started = packs.find((pack) => packStates(pack).some((state) => ran.has(state)));
      if (started) throw new StageStartedError(id, started);
      const stages: StageEngines = { ...task.stages };
      for (const pack of packs) {
        const engine = change[pack];
        if (engine === null) delete stages[pack];
        else if (engine !== undefined) stages[pack] = engine;
      }
      await tx.updateTask(id, { stages });
    });
    await this.log(id, "task.stages", { stages: change });
    return this.get(id);
  }

  /** Deletes a task with its runs, approvals and events. Its worktree is kept. */
  /** Whether a stage is running (or should be) for the task: a running state, or a `RUN_OR_GATE` state of the feature route with no open approval. */
  private async runsAStage(task: TaskRow): Promise<boolean> {
    if (RUNNING.has(task.state)) return true;
    return task.route === "feature" && RUN_OR_GATE.has(task.state) && !(await this.approvals(task.id)).some((a) => a.decision === null);
  }

  /** The tasks `RUNNING` finds, and the feature cards at a `RUN_OR_GATE` state with no open approval: what a restart or the supervisor must account for. */
  private async stuckRunning(): Promise<TaskRow[]> {
    const stuck = await this.store.findStuckTasks(RUNNING);
    for (const task of await this.store.findStuckTasks(RUN_OR_GATE)) if (task.route === "feature" && !(await this.approvals(task.id)).some((a) => a.decision === null)) stuck.push(task);
    return stuck;
  }

  /** Deletes the task and the checkout it worked in; the branch and its commits stay. Answers its tombstone's sequence number. */
  async delete(id: string): Promise<number> {
    const task = await this.get(id);
    if (await this.runsAStage(task)) throw new TaskBusyError(id, task.state);
    clearTimeout(this.resumeTimers.get(id));
    this.resumeTimers.delete(id);
    this.pausedOn.delete(id);
    if (task.repoPath && task.worktreePath) {
      await removeWorktreeOnDisk(task.repoPath, task.worktreePath).catch((error: unknown) =>
        console.error(`could not remove the worktree of deleted task ${id}`, error),
      );
    }
    return this.store.deleteTask(id);
  }

  /** Every task changed and every task deleted after the sequence number `since`, oldest first; `sourceKind` keeps one source's. */
  changesSince(since: number, sourceKind: string | null = null): Promise<TaskChange[]> {
    return this.store.changesSince(since, sourceKind);
  }

  /** The highest sequence number a committed change holds. */
  lastSeq(): Promise<number> {
    return this.store.lastSeq();
  }

  /** Removes a task's worktree from disk once you are done with it. The task, its branch
   * and commits stay; only the checkout the agent worked in is gone. */
  async removeWorktree(id: string, options: { discard?: boolean } = {}): Promise<TaskRow> {
    const task = await this.get(id);
    if (await this.runsAStage(task)) throw new TaskBusyError(id, task.state);
    if (!task.repoPath || !task.worktreePath) return task;
    // A clone is the only copy of what no remote has: say so instead of dropping it silently.
    if (!options.discard && isClone(task.worktreePath)) {
      const unpushed = await unpushedCommits(task.worktreePath);
      if (unpushed.length > 0) throw new WorktreeUnpushedError(id, unpushed.length);
    }
    await removeWorktreeOnDisk(task.repoPath, task.worktreePath);
    await this.store.updateTask(id, { worktreePath: null });
    await this.log(id, "worktree.removed", { path: task.worktreePath });
    return this.get(id);
  }

  /** Context setup: the repository, project, owners and history of the card, by script, stored on it. A failure leaves the card as it was. */
  private async resolveContext(id: string): Promise<void> {
    if (!this.contextDeps) return;
    const task = await this.get(id);
    if (task.state !== "draft") return;
    const out = await contextSetup(this.contextDeps, task).catch((error: unknown) => {
      console.warn(`context setup: ${id}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    });
    if (!out) return;
    const card = cardOf(task);
    await this.store.updateTask(id, {
      ...(out.repoPath && !task.repoPath ? { repoPath: out.repoPath } : {}),
      card: {
        ...card,
        project: out.project ?? card.project,
        owners: [...new Set([...card.owners, ...out.owners])].slice(0, 20),
        history: out.history,
        resolved: { repoPath: out.repoPath, project: out.project, at: new Date().toISOString() },
      },
    });
    await this.log(id, "context.resolved", { repoFrom: out.repoFrom, project: out.project, owners: out.owners.length, history: out.history.length });
  }

  private contextCheck(task: TaskRow) {
    const card = cardOf(task);
    return contextComplete({ repoPath: task.repoPath, title: task.title, description: task.description, reporter: card.reporter, attachments: card.attachments.length });
  }

  /** The card waits at Intake's context gate; its reporter is asked once for this visit, in fixed words. */
  private async holdForContext(id: string, missing: ContextMissing[]): Promise<TaskRow> {
    const held = await this.dispatch(id, { type: "needs_context" }, { detail: { kind: "context", missing } });
    const ask = contextAsk(missing);
    await this.log(id, "task.questions", { body: ask.body, secret: ask.secret, hash: ask.hash, by: "machine", kind: "context" });
    return held;
  }

  /** A repository a person names must be one the machine already knows, as an absolute, normalised path: never a path of their choosing. */
  private async checkKnownRepo(repoPath: string): Promise<void> {
    const known = this.knownRepos ? await this.knownRepos() : [];
    if (!isAbsolute(repoPath) || normalize(repoPath) !== repoPath || repoPath.length > 1000 || !known.includes(repoPath)) throw new UnknownRepositoryError(repoPath);
  }

  /** What a person gives the context gate: a repository, a project or more text. The card goes back through the check; complete, it goes on as a start would. */
  async provideContext(id: string, given: { repoPath?: string; project?: string; text?: string; reporterChannel?: string }): Promise<TaskRow> {
    const task = await this.get(id);
    const open = (await this.approvals(id)).find((a) => a.kind === "awaiting_setup" && a.decision === null && a.requested.kind === "context");
    if (task.state !== "awaiting_setup" || !open) throw new NoContextGateError(id, task.state);
    if (given.repoPath !== undefined) await this.checkKnownRepo(given.repoPath);
    const text = given.text?.trim().slice(0, 20_000);
    const card = cardOf(task);
    const project = given.project?.trim().slice(0, 120) || card.project;
    // A reporter with no channel cannot be asked: a person names the channel to reach them on. Only an existing reporter takes it; none is made up.
    const channel = given.reporterChannel ? channelOf(given.reporterChannel) : "";
    const reporter = card.reporter && channel ? { ...card.reporter, channel } : null;
    await this.store.updateTask(id, {
      ...(given.repoPath ? { repoPath: given.repoPath } : {}),
      ...(text ? { description: task.description ? `${task.description}\n\n${text}` : text } : {}),
      card: { ...card, project, ...(reporter ? { reporter } : {}) },
    });
    const resolved = card.resolved;
    if (resolved) {
      const corrections = correctionsOf(resolved, { repoPath: given.repoPath ?? task.repoPath, project: project ?? null });
      if (corrections.length > 0) await this.log(id, "context.corrected", { corrections });
    }
    const check = this.contextCheck(await this.get(id));
    if (!check.complete) {
      await this.store.withTaskLock(id, async (_task, tx) => {
        const now = await tx.findOpenApproval(id);
        if (now) await tx.updateApprovalRequested(now, { ...now.requested, missing: check.missing });
      });
      return this.get(id);
    }
    const decision: DecisionRecord = { decision: "answered", response: { ...(given.repoPath ? { repoPath: given.repoPath } : {}), ...(given.project ? { project: given.project } : {}), ...(reporter ? { reporterChannel: true } : {}), text: Boolean(text) } };
    // The card is whole: now it is checked for a duplicate, as a card that was whole at start is.
    if (this.dedupDeps && !cardOf(await this.get(id)).dedup?.chosen && !cardOf(await this.get(id)).dedup) {
      const checked = await this.dedupCheck(id, decision);
      if (checked) return checked;
    }
    return this.continueFromGate(id, decision);
  }

  /** Starts the pipeline; a repo with no luna.yaml yet gets the setup gate before triage. */
  async start(id: string): Promise<TaskRow> {
    await this.resolveContext(id);
    const task = await this.get(id);
    if (this.contextDeps && task.route === "feature" && task.state === "draft") {
      const check = this.contextCheck(task);
      if (!check.complete) return this.holdForContext(id, check.missing);
    }
    if (this.dedupDeps && task.route === "feature" && task.state === "draft" && !cardOf(task).dedup?.chosen) {
      const checked = await this.dedupCheck(id);
      if (checked) return checked;
    }
    if (task.state === "draft" && (cardOf(task).dependsOn?.length ?? 0) > 0) {
      const held = await this.holdOrRelease(task);
      if (held) return held;
    }
    const setup = task.route === "setup" || (task.repoPath !== null && !this.hasConfig(task.repoPath));
    return this.dispatch(id, { type: "start", setup });
  }

  /** The open cards stacked on this one. */
  stackedOn(id: string): Promise<TaskRow[]> {
    return this.store.findStackedOn(id);
  }

  /** Whether the card's last shipping run ended in a merge. */
  async mergeRecorded(id: string): Promise<boolean> {
    return (await this.mergedPr(id)) !== null;
  }

  /** What a stacked card's workspace is cut from, from the rows as they are now: the parent's branch while its PR is open, `merged` once it merged (the card then starts from the default branch), `gone` when it was archived or is no card. Null for a card with no base. */
  async baseOf(task: TaskRow): Promise<{ state: "open"; branch: string } | { state: "merged" } | { state: "gone"; reason: string } | null> {
    const base = cardOf(task).base;
    if (!base) return null;
    const fact = (await this.dependencyFacts([base.card])).get(base.card);
    if (fact?.merged) return { state: "merged" };
    const short = base.card.slice(0, 8);
    if (!fact || fact.state === "archived") return { state: "gone", reason: `the card this one is stacked on (${short}) was ${fact ? `archived (${fact.archiveReason ?? "no reason"})` : "removed"}; it needs a person` };
    return { state: "open", branch: base.branch };
  }

  /** The card left its stack (its parent merged and it now targets the default branch): the base goes, under the lock, and the retarget is logged once. */
  async clearBase(id: string): Promise<void> {
    await this.store.withTaskLock(id, async (task, tx) => {
      const { base, ...rest } = cardOf(task);
      if (!base) return;
      await tx.updateTask(id, { card: rest });
      await tx.recordEvent({ taskId: id, kind: "stack.retargeted", payload: { to: "default" }, stageRunId: null });
    });
  }

  private releasing = false;
  private releaseAgain = false;

  /** Tries every draft that waits for its dependencies (`startWhenReady`) through `start` again. A call made while another runs (a card closing inside a stage loop that is itself releasing) asks that one to go round once more; it never waits for it. */
  async releaseHeld(): Promise<void> {
    if (this.releasing) {
      this.releaseAgain = true;
      return;
    }
    this.releasing = true;
    try {
      do {
        this.releaseAgain = false;
        for (const row of await this.store.listTasks()) {
          const card = cardOf(row);
          if (row.state !== "draft" || card.startWhenReady !== true || (card.dependsOn?.length ?? 0) === 0) continue;
          await this.start(row.id).catch((error: unknown) => console.error(`could not release held card ${row.id}`, error));
        }
      } while (this.releaseAgain && !this.stopping);
    } finally {
      this.releasing = false;
    }
  }

  /** What the dependency rule needs of the cards a card waits for, and of the cards they are stacked on (at most 200 reads, so a long or looping chain cannot run on). */
  private async dependencyFacts(ids: readonly string[]): Promise<Map<string, DepFact>> {
    const facts = new Map<string, DepFact>();
    const queue = [...ids];
    for (let reads = 0; queue.length > 0 && reads < 200; reads++) {
      const id = queue.shift()!;
      if (facts.has(id) || !UUID.test(id)) continue;
      const row = await this.store.getTask(id);
      if (!row) continue;
      const card = cardOf(row);
      const delivered = (await this.latestStageFinish(id, "delivering"))?.detail;
      const merged = row.state === "closed" ? !card.mergedInto : row.state === "reviewing_memory" ? (await this.mergedPr(id)) !== null : false;
      facts.set(id, { id, repoPath: row.repoPath, branch: row.branch, state: row.state, archiveReason: row.archiveReason, hasOpenPr: typeof delivered?.prNumber === "number", merged, base: card.base ?? null, mergedInto: card.mergedInto ?? null });
      if (card.mergedInto) queue.push(card.mergedInto);
      if (card.base) queue.push(card.base.card);
    }
    return facts;
  }

  /** The dependency rule at start: a card that must wait stays a draft (and says what for, when that changed); one that may go on takes its base and starts. Null means "start as usual". */
  private async holdOrRelease(task: TaskRow): Promise<TaskRow | null> {
    const card = cardOf(task);
    const maxDepth = (await this.policyFor(task.repoPath)).factory.size.max_children;
    const facts = await this.dependencyFacts(card.dependsOn ?? []);
    const verdict = schedulable({ id: task.id, repoPath: task.repoPath, dependsOn: card.dependsOn ?? [] }, facts, { maxDepth });
    const last = (await this.events(task.id)).findLast((e) => e.kind === "card.held" || e.kind === "card.released");
    return this.store.withTaskLock(task.id, async (now, tx) => {
      if (now.state !== "draft") return this.get(task.id);
      const current = cardOf(now);
      if (!verdict.ok) {
        if (current.startWhenReady !== true) await tx.updateTask(task.id, { card: { ...current, startWhenReady: true } });
        const text = holdText(verdict, facts);
        const same = last?.kind === "card.held" && last.payload.reason === verdict.reason && JSON.stringify(last.payload.waitingOn) === JSON.stringify(verdict.waitingOn) && last.payload.text === text;
        if (!same) await tx.recordEvent({ taskId: task.id, kind: "card.held", payload: { reason: verdict.reason, waitingOn: verdict.waitingOn, text }, stageRunId: null });
        return this.get(task.id);
      }
      const { base: _gone, ...rest } = current;
      await tx.updateTask(task.id, { card: verdict.base ? { ...rest, base: verdict.base } : rest });
      await tx.recordEvent({ taskId: task.id, kind: "card.released", payload: { base: verdict.base }, stageRunId: null });
      return null;
    });
  }

  /** A linked ticket\'s scope or priority changed: the card, before Build, keeps the field names and the time, and its open gate shows them ("the ticket changed since this was written"). The next gate it opens before Build carries them too. After Build a flag is the machine's business, not the gate\'s. */
  async noteTicketChange(id: string, change: { fields: string[]; at: string }): Promise<void> {
    await this.store.withTaskLock(id, async (task, tx) => {
      if (!BEFORE_BUILD.has(task.state)) return;
      const prior = cardOf(task).ticketChanged;
      const ticketChanged = { fields: [...new Set([...(prior?.fields ?? []), ...change.fields])], at: change.at };
      await tx.updateTask(id, { card: { ...cardOf(task), ticketChanged } });
      const open = await tx.findOpenApproval(id);
      if (open) await tx.updateApprovalRequested(open, { ...open.requested, ticketChanged });
    });
  }

  /** A card at an Intake gate goes on as a start would: through setup when its repo has no luna.yaml, else to its entry. */
  private async continueFromGate(id: string, decision: DecisionRecord): Promise<TaskRow> {
    const after = await this.get(id);
    const setup = after.repoPath !== null && !this.hasConfig(after.repoPath);
    return this.dispatch(id, { type: "context_given", setup }, { decision });
  }

  /** The cards a new card could be a report of: those of the same repository only, open ones, closed ones (not merged duplicates) and the backlog's items. */
  private async dedupCandidates(task: TaskRow): Promise<Candidate[]> {
    if (!task.repoPath) return [];
    // A card typed in the TUI has no source and is the operator's own: it sees everything of its repository. Any other card sees only what its reporter could already see.
    const sources = cardOf(task).audience ?? cardOf(task).sources;
    return this.candidatesFor({ repoPath: task.repoPath, sources, operator: sources.length === 0 && !task.jira && (!cardOf(task).splitFrom || cardOf(task).audience !== undefined), excludeId: task.id });
  }

  /**
   * The closed cards of the card's repository with a counted diff, for the size prompt's "similar cards": only those its own audience could already see
   * (`canSeeKept`, as `candidatesFor`), the operator's own card seeing every one. A failed read is no cards.
   */
  async closedSized(task: TaskRow): Promise<Array<Candidate & { diffAdded: number | null; diffRemoved: number | null }>> {
    if (!task.repoPath) return [];
    try {
      const sources = cardOf(task).audience ?? cardOf(task).sources;
      // A child of a split has no source of its own: it is the operator's only when its origin was.
      const operator = sources.length === 0 && !task.jira && (!cardOf(task).splitFrom || cardOf(task).audience !== undefined);
      const self = { repoPath: task.repoPath, sources };
      return (await this.store.listTasks())
        .filter((r) => r.id !== task.id && r.repoPath === task.repoPath && r.state === "closed" && !cardOf(r).mergedInto && r.diffAdded !== null && r.diffRemoved !== null)
        .filter((r) => operator || canSeeKept(self, { repoPath: r.repoPath, sources: cardOf(r).sources }))
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, 500)
        .map((r) => ({ id: r.id, kind: "closed" as const, title: r.title, text: r.description, repo: r.repoPath, closedAt: r.stateSince ?? r.updatedAt, diffAdded: r.diffAdded, diffRemoved: r.diffRemoved }));
    } catch {
      return [];
    }
  }

  /** For each id that is a card: its state and whether the dependency rule calls it satisfied (merged, or with an open PR). An id that is no card is absent. At most 50 ids. */
  async dependencyStates(ids: readonly string[]): Promise<Map<string, { state: string; satisfied: boolean }>> {
    const wanted = ids.filter((id) => UUID.test(id)).slice(0, 50);
    const facts = await this.dependencyFacts(wanted);
    const out = new Map<string, { state: string; satisfied: boolean }>();
    for (const id of wanted) {
      const fact = facts.get(id);
      if (!fact) continue;
      out.set(id, { state: fact.state, satisfied: schedulable({ id: "backlog-item", repoPath: null, dependsOn: [id] }, facts, { maxDepth: 1000 }).ok });
    }
    return out;
  }

  /** The counted diff of closed cards by id (ids the caller already filtered by audience). */
  async countedDiffs(ids: string[]): Promise<Array<{ id: string; added: number; removed: number }>> {
    const out: Array<{ id: string; added: number; removed: number }> = [];
    for (const id of ids.slice(0, 50)) {
      const row = UUID.test(id) ? await this.store.getTask(id).catch(() => null) : null;
      if (row && row.state === "closed" && row.diffAdded !== null && row.diffRemoved !== null) out.push({ id, added: row.diffAdded, removed: row.diffRemoved });
    }
    return out;
  }

  /** The cards and backlog items a ticket (not yet a card) could be a report of: only what its own source could already see (`canSeeKept`), failing closed. The Ticket Machine's enrichment reads this. */
  async ticketCandidates(repoPath: string | null, source: TaskSource): Promise<Candidate[]> {
    if (!repoPath) return [];
    return this.candidatesFor({ repoPath, sources: [source], operator: false, excludeId: null });
  }

  /**
   * In a channel a repository claims in `conversation.channels`: that repository's cards whose first source is a ticket (a Jira issue or a
   * GitHub issue), each marked with where it came from. Never a card whose first source is another Slack conversation, a DM or nothing.
   * The caller shows the mark before anything is posted.
   */
  async claimedRepoCandidates(repoPath: string): Promise<Array<Candidate & { otherSource: { kind: "jira" | "github"; key: string } }>> {
    const out: Array<Candidate & { otherSource: { kind: "jira" | "github"; key: string } }> = [];
    const rows = (await this.store.listTasks()).filter((r) => r.repoPath === repoPath && r.state !== "archived").sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, 500);
    for (const r of rows) {
      const card = cardOf(r);
      if (card.mergedInto) continue;
      const first = card.sources[0];
      const otherSource = first && "kind" in first && first.kind === "jira" ? ({ kind: "jira", key: first.key } as const) : first && "kind" in first && first.kind === "github" ? ({ kind: "github", key: `${first.repo}#${first.number}` } as const) : null;
      if (!otherSource) continue;
      out.push({ id: r.id, kind: r.state === "closed" ? "closed" : "open", title: r.title, text: r.description, repo: r.repoPath, closedAt: r.state === "closed" ? (r.stateSince ?? r.updatedAt) : null, otherSource });
    }
    return out;
  }

  private async candidatesFor(o: { repoPath: string; sources: ReturnType<typeof cardOf>["sources"]; operator: boolean; excludeId: string | null }): Promise<Candidate[]> {
    const task = { id: o.excludeId, repoPath: o.repoPath };
    const operator = o.operator;
    const self = { repoPath: o.repoPath, sources: o.sources };
    const cardOfSources = o.sources;
    const cards = (await this.store.listTasks())
      .filter((r) => r.id !== task.id && r.repoPath === task.repoPath && r.state !== "archived" && !cardOf(r).mergedInto)
      .filter((r) => operator || canSeeKept(self, { repoPath: r.repoPath, sources: cardOf(r).sources }))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, 500)
      .map((r): Candidate => ({ id: r.id, kind: r.state === "closed" ? "closed" : "open", title: r.title, text: r.description, repo: r.repoPath, closedAt: r.state === "closed" ? (r.stateSince ?? r.updatedAt) : null }));
    const slugs = cardOfSources.flatMap((s) => ("kind" in s && (s.kind === "github" || s.kind === "github_pr") ? [s.repo] : []));
    const items = ((await this.dedupDeps?.backlog?.list().catch(() => [])) ?? []).filter((i) => i.repo !== null && (i.repo === task.repoPath || slugs.includes(i.repo)))
      .filter((i) => operator || canSeeKept(self, { repoPath: task.repoPath, sources: i.sources }));
    return [...cards, ...items.map((i): Candidate => ({ id: i.id, kind: "backlog", title: i.title, text: i.text, repo: task.repoPath, closedAt: null }))];
  }

  /** Intake's duplicate check. A merged card, or one held at the dedup gate, is returned; null means the card goes on. */
  private async dedupCheck(id: string, decision?: DecisionRecord): Promise<TaskRow | null> {
    const deps = this.dedupDeps!;
    const task = await this.get(id);
    const policy = (await this.policyFor(task.repoPath)).factory;
    let recordId: string | null = null;
    const found = await checkDuplicates(
      { decide: async (ctx) => { const r = await deps.decide(ctx); recordId = r.recordId ?? null; return r.answer; } },
      { title: task.title, text: task.description, repo: task.repoPath },
      await this.dedupCandidates(task),
      { now: new Date(), dedup: policy.dedup },
    );
    const { outcome } = found;
    const kept = outcome.duplicate && outcome.duplicate.kind !== "backlog" ? await this.store.getTask(outcome.duplicate.id) : null;
    const mergeable = outcome.duplicate !== null && (outcome.duplicate.kind === "backlog" || (kept !== null && !TERMINAL.has(kept.state)));
    const label: NonNullable<CardFields["dedup"]>["outcome"] = found.shortlist.length === 0 ? "none" : found.failed ? "skipped" : outcome.duplicate && mergeable ? "duplicate" : outcome.duplicate || outcome.ask.length > 0 ? "ask" : outcome.related.length > 0 ? "related" : "none";
    const record = {
      at: new Date().toISOString(),
      recordId,
      candidates: found.shortlist.map((n, i) => ({ id: n.id, kind: n.kind, score: n.score, slot: i + 1 })),
      answer: found.answer as Record<string, { choice: string; confidence: number }> | null,
      outcome: label,
    };
    await this.store.updateTask(id, { card: { ...cardOf(task), dedup: record } });
    if (label === "skipped") await this.log(id, "intake.dedup_skipped", { reason: "the decision failed" });
    if (label === "duplicate" && outcome.duplicate) {
      if (outcome.duplicate.kind === "backlog") return this.mergeIntoBacklog(id, outcome.duplicate.id, decision);
      return this.merge(id, outcome.duplicate.id, "machine", decision);
    }
    if (label === "ask") {
      const ask = found.shortlist.filter((n) => n.id === outcome.duplicate?.id || outcome.ask.some((a) => a.id === n.id));
      const shown = await Promise.all(
        ask.map(async (n) => {
          const row = n.kind === "backlog" ? null : await this.store.getTask(n.id);
          const title = row?.title ?? (await deps.backlog?.list().catch(() => []))?.find((i) => i.id === n.id)?.title ?? "";
          return { id: n.id, kind: n.kind, title: title.replace(/\s+/g, " ").slice(0, 200), state: row?.state ?? null, score: n.score, slot: found.shortlist.indexOf(n) + 1 };
        }),
      );
      return this.dispatch(id, { type: "needs_context" }, { detail: { kind: "dedup", candidates: shown }, ...(decision ? { decision } : {}) });
    }
    if (label === "related") await this.linkRelated(id, outcome.related.map((n) => n.id));
    return null;
  }

  /** Links `id` and each of `ids` that is a card as related to one another. */
  private async linkRelated(id: string, ids: string[]): Promise<void> {
    for (const other of ids) {
      const row = await this.store.getTask(other);
      if (!row) continue;
      const mine = cardOf(await this.get(id));
      await this.store.updateTask(id, { card: { ...mine, related: [...new Set([...(mine.related ?? []), other])].slice(0, 20) } });
      const theirs = cardOf(row);
      await this.store.updateTask(other, { card: { ...theirs, related: [...new Set([...(theirs.related ?? []), id])].slice(0, 20) } });
      await this.log(id, "intake.related", { with: other });
    }
  }

  /** A duplicate of a backlog item: the item is bumped (one more report) and the card closes as merged into it. */
  private async mergeIntoBacklog(id: string, itemId: string, decision?: DecisionRecord): Promise<TaskRow> {
    await this.dedupDeps?.backlog?.bump(itemId);
    await this.log(id, "card.merged", { into: itemId, backlog: true });
    return this.closeAsMerged(id, itemId, decision);
  }

  /** The answer to the dedup gate: the duplicate of one listed candidate, related to some of them, or neither. Ids come from the listed candidates only;
   *  the answer is ground truth on the `intake_dedup` record, for every slot. */
  async answerDedup(id: string, answer: { choice: "duplicate" | "related" | "neither"; of?: string[] }): Promise<TaskRow> {
    const task = await this.get(id);
    const open = (await this.approvals(id)).find((a) => a.kind === "awaiting_setup" && a.decision === null && a.requested.kind === "dedup");
    if (task.state !== "awaiting_setup" || !open) throw new NoContextGateError(id, task.state);
    const listed = (Array.isArray(open.requested.candidates) ? open.requested.candidates : []) as Array<{ id: string; kind: "open" | "closed" | "backlog"; slot: number }>;
    const of = answer.choice === "neither" ? [] : [...new Set(answer.of ?? [])];
    if (of.some((x) => !listed.some((c) => c.id === x))) throw new DedupAnswerError("name only the candidates the gate lists");
    if (answer.choice === "duplicate" && of.length !== 1) throw new DedupAnswerError("name exactly one candidate as the original");
    if (answer.choice === "related" && of.length === 0) throw new DedupAnswerError("name the candidates it is related to");
    const record = cardOf(task).dedup;
    if (record?.recordId && this.truth) {
      const label = Object.fromEntries(listed.map((c) => [`slot${c.slot}`, { choice: !of.includes(c.id) ? "different" : answer.choice === "duplicate" ? "same" : "related" }]));
      await this.truth.learned({ pack: "intake_dedup", recordId: record.recordId, label, kind: "person", source: "dedup_answer", taskId: id }).catch(() => false);
    }
    if (record) await this.store.updateTask(id, { card: { ...cardOf(task), dedup: { ...record, chosen: answer.choice } } });
    const decision: DecisionRecord = { decision: "answered", response: { choice: answer.choice, of } };
    if (answer.choice === "duplicate") {
      const original = listed.find((c) => c.id === of[0])!;
      return original.kind === "backlog" ? this.mergeIntoBacklog(id, original.id, decision) : this.merge(id, original.id, "machine", decision);
    }
    if (answer.choice === "related") await this.linkRelated(id, of);
    return this.continueFromGate(id, decision);
  }

  /** Closes a card as merged: nothing runs, no host close step (it has no workspace or PR worth cleaning), and it remembers where it went. */
  private async closeAsMerged(id: string, intoId: string, decision?: DecisionRecord): Promise<TaskRow> {
    await this.apply(id, { type: "merged" }, decision ? { decision } : {});
    this.loops.get(id)?.abort();
    const row = await this.get(id);
    await this.store.updateTask(id, { queued: false, card: { ...cardOf(row), mergedInto: intoId } });
    clearTimeout(this.resumeTimers.get(id));
    this.resumeTimers.delete(id);
    await this.untilLoopEnds(id, ABORT_WIND_DOWN_MS);
    return this.get(id);
  }

  answer(id: string, answers: Record<string, string>): Promise<TaskRow> {
    return this.dispatch(
      id,
      { type: "answered" },
      { decision: { decision: "answered", response: { answers } } },
    );
  }

  /** Approves, requests changes (`changes_requested`, which is `sent_back` and stored as such) or rejects whatever the task is waiting on,
   *  including an escalation. A rejection is the plan gate's alone: the card is archived with reason `rejected`. */
  async decide(
    id: string,
    wanted: "approved" | "changes_requested" | "rejected" | "sent_back",
    reason?: string,
    response?: Record<string, unknown>,
    options: { approver?: string; auto?: boolean } = {},
  ): Promise<TaskRow> {
    // A person resuming an escalated card: what they do on the branch from here is ground truth for the reason that was decided.
    const before = await this.get(id);
    const escalated = before.state === "escalated" && !options.auto ? (await this.approvals(id)).find((a) => a.kind === "escalated" && a.decision === null) : undefined;
    // "Build's budget is spent: a person decides": a person who approves has decided the card goes on, so it goes on with a fresh budget.
    // Without one, the next Build reads the same spent budget and escalates again, and approving can never move the card.
    if (escalated && wanted === "approved" && budgetWasSpent(escalated.requested)) await this.log(id, "build.budget_reset", { reason: "a person approved the card past its spent budget" });
    // A person approving a plan made after Build already ran has decided the card builds that plan: its Build counts from a fresh budget.
    // Otherwise the runs spent on the old plan (and its bounces) escalate the new one before it starts, and the stronger model's one run is burnt.
    if (before.state === "awaiting_approval" && wanted === "approved" && !options.auto && (await this.events(id)).some((e) => e.kind === "stage.finished" && e.payload.stage === "implementing")) {
      await this.log(id, "build.budget_reset", { reason: "a person approved a new plan" });
    }
    const moved = await this.decideNow(id, wanted, reason, response, options);
    if (escalated) await this.keepEscalationTruth(moved, escalated.id);
    if (escalated) await this.confirmEscalationReason(id, escalated);
    return moved;
  }

  private async decideNow(
    id: string,
    wanted: "approved" | "changes_requested" | "rejected" | "sent_back",
    reason?: string,
    response?: Record<string, unknown>,
    options: { approver?: string; auto?: boolean } = {},
  ): Promise<TaskRow> {
    const { approver } = options;
    const decision: "approved" | "sent_back" | "rejected" = wanted === "changes_requested" ? "sent_back" : wanted;
    const task = await this.get(id);
    // A state that holds a stage or a gate answers a decision only while a gate is open: a watched card has nobody to answer.
    if (RUN_OR_GATE.has(task.state) && task.route === "feature" && (await this.runsAStage(task))) throw new TransitionError(task, { type: decision === "approved" ? "approved" : "sent_back" });
    if (decision === "rejected") return this.reject(task, reason, options.auto === true);
    // The gate this decision closes, read before it moves: what a decision pack said about it is judged by what the person does here.
    const gate = this.truth && !options.auto ? (await this.approvals(id)).find((a) => a.decision === null) : undefined;
    const open = task.state === "awaiting_approval" ? (await this.approvals(id)).find((a) => a.kind === "awaiting_approval" && a.decision === null) : undefined;
    const outcome = open?.requested.outcome;
    // Keeping the card whole is a person's answer at a split gate and nowhere else: on any other gate the word is dropped, so it can never be recorded by riding on an ordinary approval.
    if (response && "keepWhole" in response && !(decision === "approved" && isSplitOutcome(outcome))) {
      const { keepWhole: _dropped, ...rest } = response;
      response = Object.keys(rest).length > 0 ? rest : undefined;
    }
    if (decision === "approved" && open && isSplitOutcome(outcome)) {
      if (options.auto === true) throw new SplitAutoApprovalError(id);
      if (response?.keepWhole !== true && outcome === "split_failed") throw new SplitNotValidError(id);
      // The same names a plan of the origin's risk needs, for the split and for keeping the card whole; a first name only waits on the gate.
      const names = await this.splitApprovers(id, task, approver);
      if (names.partial) return this.get(id);
      if (names.names.length > 1) response = { ...response, approvers: names.names };
      if (response?.keepWhole !== true) {
        return this.approveSplit(id, open, { ...(reason ? { reason } : {}), ...(approver ? { approver } : {}), ...(names.names.length > 1 ? { approvers: names.names } : {}), gate });
      }
      // Kept whole: the gate closes approved with the person's answer, and the plan stage runs again, which now plans without the size guard.
      const size = (open.requested.size ?? {}) as { estLoc?: unknown; planned?: unknown; by?: unknown; limit?: { hard?: unknown } };
      const lines = size.by === "plan" && typeof size.planned === "number" ? size.planned : size.estLoc;
      const kept = await this.dispatch(id, { type: "sent_back", from: "plan" }, { decision: { decision: "approved", reason, response: { keepWhole: true, ...(approver ? { approver } : {}), ...(names.names.length > 1 ? { approvers: names.names } : {}) } }, onlyFrom: new Set<TaskState>(["awaiting_approval"]) });
      await this.log(id, "size.overridden", { estLoc: typeof lines === "number" ? lines : 0, limit: typeof size.limit?.hard === "number" ? size.limit.hard : 0 });
      if (gate) await this.learnFromGate(id, gate, "approved", { keepWhole: true });
      return kept;
    }
    // The plan needs as many distinct names as its level asks (the repo's `plan.approvers`: one for every level by default), at least one from outside
    // the code owners on a high-risk plan whose owners CODEOWNERS names (never a model's word). The rule is computed under the task lock from
    // the gate as it is now (an edit that raised the risk is seen); the names so far are kept on the gate and the last one closes it. The level is
    // `requested.risk.level`: the higher of the machine's and a person's, never lower than the machine's.
    let answered = response;
    let guard: Extra["guard"];
    if (decision === "approved" && open && outcome === undefined) {
      const ruleOf = (requested: Record<string, unknown>) => this.planRuleOf(task, requested);
      const prior = await this.store.withTaskLock(id, async (_task, tx) => {
        const fresh = await tx.findOpenApproval(id);
        if (!fresh || fresh.kind !== "awaiting_approval" || fresh.requested.outcome !== undefined) return null;
        const { rule, owners } = await ruleOf(fresh.requested);
        if (rule.needed <= 1) return { names: [] as string[], partial: false, needed: rule.needed };
        const names = Array.isArray(fresh.requested.approvers) ? fresh.requested.approvers.map(String) : [];
        if (!approver) throw new ApproverRequiredError(id, "plan", rule.needed);
        if (names.some((n) => sameName(n, approver))) throw new SameApproverError(id, approver);
        if (names.length + 1 < rule.needed) {
          await tx.updateApprovalRequested(fresh, { ...fresh.requested, approvers: [...names, approver] });
          return { names, partial: true, needed: rule.needed };
        }
        if (rule.outside === "required" && !outsideSatisfied([...names, approver], owners)) throw new OutsideApproverRequiredError(id, approver);
        return { names, partial: false, needed: rule.needed };
      });
      if (prior?.partial) {
        await this.log(id, "approval.partial", { approver, needed: prior.needed, have: prior.names.length + 1 });
        return this.get(id);
      }
      if (prior && prior.needed > 1) answered = { ...response, approvers: [...prior.names, approver!] };
      // Checked once more under the lock that closes the gate: an edit that raised the risk since cannot be approved past.
      guard = async (gate) => {
        if (!gate || gate.kind !== "awaiting_approval" || gate.requested.outcome !== undefined) return;
        const { rule, owners } = await ruleOf(gate.requested);
        if (rule.needed <= 1) return;
        const names = Array.isArray(answered?.approvers) ? answered.approvers.map(String) : approver ? [approver] : [];
        if (names.length < rule.needed) throw new ApproverRequiredError(id, "plan", rule.needed);
        if (rule.outside === "required" && !outsideSatisfied(names, owners)) throw new OutsideApproverRequiredError(id, names.at(-1) ?? "");
      };
    }
    // The release question (the watch asks it after readiness): a High-risk card ships, when the repo asks two people of a High-risk plan, only on the word
    // of someone who is none of the plan's approvers and, when the gate names release owners, one of them. Team handles cannot be checked here: the name is an attestation. Nothing a model wrote picks them.
    const release = task.state === "awaiting_ship" && task.route !== "review" ? (await this.approvals(id)).find((a) => a.kind === "awaiting_ship" && a.decision === null && a.requested.gate === "ship_approval") : undefined;
    if (release && decision === "sent_back") throw new TransitionError(task, { type: "sent_back" });
    if (release && decision === "approved") {
      if (release.requested.risk === "high" || task.evidence?.risk === "high") {
        // Someone other than the plan's approvers is asked only where the repo asks for two people on a High-risk plan (`plan.approvers.high` above 1):
        // with one operator (the default) the person who approved the plan approves the release.
        const separate = (await this.policyFor(task.repoPath)).factory.plan.approvers.high > 1;
        const owners = Array.isArray(release.requested.releaseOwners) ? release.requested.releaseOwners.map(String) : [];
        if (separate || owners.length > 0) {
          if (!approver) throw new ApproverRequiredError(id, "ship", separate ? 2 : 1);
          if (separate) {
            const plan = (await this.approvals(id)).findLast((a) => a.kind === "awaiting_approval" && a.decision === "approved")?.response;
            const planNames = [...(Array.isArray(plan?.approvers) ? plan.approvers.map(String) : []), ...(typeof plan?.approver === "string" ? [plan.approver] : [])];
            if (planNames.some((n) => sameName(n, approver))) throw new SameApproverError(id, approver, "ship");
          }
          if (owners.length > 0 && !owners.some((o) => sameName(o, approver))) throw new NotReleaseOwnerError(id, approver);
        }
      }
      if (typeof release.requested.head === "string") answered = { ...answered, head: release.requested.head };
    }
    if (approver) answered = { ...answered, approver };
    const record = { decision, reason, ...(answered ? { response: answered } : {}) };
    if (decision === "approved" && outcome === "conversation") {
      // One tap: the reply is posted where the card came from and the conversation ends closed, not archived. The close runs under
      // the row lock, so only the request that closed the gate goes on to post.
      await this.dispatch(id, { type: "replied" }, { decision: record, onlyFrom: new Set<TaskState>(["awaiting_approval"]) });
      await this.log(id, "task.reply", { body: String(open!.requested.reply ?? ""), by: "person" });
      if (gate) await this.learnFromGate(id, gate, decision, response);
      return this.get(id);
    }
    if (decision === "approved" && outcome === "archive") {
      // One click: an archive is final and neither plans nor posts.
      const archived = await this.archive(id, TRIAGE_ARCHIVE[String(open!.requested.archiveReason)] ?? "rejected", { decision: record });
      if (gate) await this.learnFromGate(id, gate, decision, response);
      return (await this.store.getTask(id)) ?? archived;
    }
    // A gate that carries triage's outcome came from triage; any other open approval is the plan stage's.
    // The watch's release question says so on its approval; the preview gate (and a gate stored before this wave) has no such word.
    const shipGate = task.state === "awaiting_ship" && (await this.approvals(id)).find((a) => a.kind === "awaiting_ship" && a.decision === null)?.requested.gate === "ship_approval" ? ({ gate: "ship_approval" } as const) : {};
    const event: PipelineEvent = decision === "approved" ? { type: "approved", ...shipGate } : { type: "sent_back", from: outcome === undefined || isSplitOutcome(outcome) ? "plan" : "triage", ...shipGate };
    const moved = await this.dispatch(id, event, { decision: record, ...(guard ? { guard } : {}) });
    if (decision === "approved" && open && outcome === undefined) await this.keepGroundTruth(moved, open.id);
    // A split gate sent back leaves no half-made children behind: they were never started and are not wanted.
    if (decision === "sent_back" && open && isSplitOutcome(outcome)) await this.archiveSplitLeftovers(id, open);
    if (gate) await this.learnFromGate(id, gate, decision, response);
    return moved;
  }

  /** What the outside-approver rule reads for a gate: CODEOWNERS' owners for the map's change and test files and the plan's step files. Never a model's owners. */
  /** Who may approve a gate of this risk, from the repo's `plan.approvers` and (for high) the owners of the files the gate names; the level is `requested.risk.level`. */
  private async planRuleOf(task: TaskRow, requested: Record<string, unknown>): Promise<{ rule: ReturnType<typeof approvalRule>; owners: string[] }> {
    const configured = (await this.policyFor(task.repoPath)).factory.plan.approvers;
    const lv = (requested.risk as { level?: unknown } | undefined)?.level;
    // The higher of the gate's grade and the card's own: a record corrected after the gate was written still counts.
    const graded = maxRisk((typeof lv === "string" ? lv : "none") as Risk, (task.record?.risk ?? "none") as Risk);
    const level: Risk = graded === "high" || graded === "medium" ? graded : "low";
    let owners: OwnersState = level === "high" ? await this.ruleOwnersOf(task.repoPath, requested) : { state: "skipped" };
    // CODEOWNERS could not be read just now: the owners the gate was opened with (the machine's own reading, kept on the gate) still hold,
    // so a lookup that fails at the moment of approval does not switch the condition off.
    const kept = requested.ruleOwners as { state?: unknown; owners?: unknown } | undefined;
    if (owners.state === "not_checked" && kept?.state === "ok" && Array.isArray(kept.owners) && kept.owners.length > 0) owners = { state: "ok", owners: kept.owners.map(String) };
    return { rule: approvalRule(level, configured, owners), owners: owners.state === "ok" ? owners.owners : [] };
  }

  /** The approvers of a split gate (to split, or to keep the card whole): the same rule a plan of the origin's risk has, taken under the task lock; the names so far are kept on the gate and the last one closes it. */
  private async splitApprovers(id: string, task: TaskRow, approver: string | undefined): Promise<{ partial: true } | { partial: false; names: string[] }> {
    const outcome = await this.store.withTaskLock(id, async (_task, tx) => {
      const fresh = await tx.findOpenApproval(id);
      if (!fresh || fresh.kind !== "awaiting_approval" || !isSplitOutcome(fresh.requested.outcome)) return { partial: false as const, names: [] as string[], needed: 1 };
      const { rule, owners } = await this.planRuleOf(task, fresh.requested);
      if (rule.needed <= 1) return { partial: false as const, names: [] as string[], needed: 1 };
      const names = Array.isArray(fresh.requested.approvers) ? fresh.requested.approvers.map(String) : [];
      if (!approver) throw new ApproverRequiredError(id, "plan", rule.needed);
      if (names.some((n) => sameName(n, approver))) throw new SameApproverError(id, approver);
      if (names.length + 1 < rule.needed) {
        await tx.updateApprovalRequested(fresh, { ...fresh.requested, approvers: [...names, approver] });
        return { partial: true as const, names, needed: rule.needed };
      }
      if (rule.outside === "required" && !outsideSatisfied([...names, approver], owners)) throw new OutsideApproverRequiredError(id, approver);
      return { partial: false as const, names: [...names, approver], needed: rule.needed };
    });
    if (outcome.partial) {
      await this.log(id, "approval.partial", { approver, needed: outcome.needed, have: outcome.names.length + 1 });
      return { partial: true };
    }
    return outcome;
  }

  private async ruleOwnersOf(repoPath: string | null, requested: Record<string, unknown>): Promise<OwnersState> {
    if (!repoPath || !this.owners) return ownersStateOf(null);
    const map = CodeMapAnswer.safeParse(requested.map);
    const plan = Plan.safeParse(requested.plan);
    const slices = Array.isArray(requested.slices) ? requested.slices : [];
    const stepFiles = plan.success ? plan.data.steps.flatMap((st) => st.files ?? st.touchpoints) : slices.flatMap((sl) => (Array.isArray((sl as { touchpoints?: unknown }).touchpoints) ? ((sl as { touchpoints: unknown[] }).touchpoints.map(String)) : []));
    const found = await this.owners(repoPath, ruleFiles(map.success ? map.data : null, stepFiles)).catch((): "failed" => "failed");
    return ownersStateOf(found);
  }

  /** How an approval of a split would be made now: child tickets when the tracker port knows the card's ticket, else child cards. */
  async splitVia(task: TaskRow): Promise<"cards" | "tickets"> {
    return (await this.splitTickets?.knows(task).catch(() => null)) ? "tickets" : "cards";
  }

  /** A person approved the split the gate shows: the children are made (cards once each, under `split:<origin>:<n>`; or tickets through the port), then the origin ends `split`.
   *  Checked first against the repository's limits as they are now and against the way of splitting the gate was opened for. A failure midway archives nothing; the next approval goes on from the keys. */
  private async approveSplit(id: string, open: ApprovalRow, how: { reason?: string; approver?: string; approvers?: string[]; gate: ApprovalRow | undefined }): Promise<TaskRow> {
    const task = await this.get(id);
    const proposed = (open.requested.split ?? {}) as { children?: unknown; via?: unknown };
    const parsed = z.array(SplitChild).safeParse(proposed.children);
    if (!parsed.success) throw new SplitNotValidError(id);
    const limits = sizeLimits((await this.policyFor(task.repoPath)).factory.size);
    const facts = splitFacts(parsed.data, { criteria: criteriaOf(task.criteria) }, { hard: limits.hard, maxChildren: limits.maxChildren });
    if (facts.issues.length > 0) throw new SplitNotValidError(id);
    const via = await this.splitVia(task);
    if (proposed.via !== via) throw new SplitChangedError(id, String(proposed.via), via);
    const kids = facts.children;
    const record = { decision: "approved" as const, ...(how.reason ? { reason: how.reason } : {}), response: { ...(how.approver ? { approver: how.approver } : {}), ...(how.approvers ? { approvers: how.approvers } : {}) } };
    // A child is never riskier than the gate's own level allows to fall: its floor is the origin's risk.
    const gateRisk = (open.requested.risk ?? {}) as { level?: unknown; machine?: unknown };
    const floor: "low" | "medium" | "high" = gateRisk.level === "high" || gateRisk.machine === "high" ? "high" : gateRisk.level === "medium" || gateRisk.machine === "medium" ? "medium" : "low";
    if (via === "tickets") {
      await this.splitTickets!.create(task, kids, open.id, floor);
      await this.log(id, "card.split", { children: kids.length, via: "tickets" });
      await this.archive(id, "split", { onlyFrom: new Set<TaskState>(["awaiting_approval"]), decision: record });
      if (how.gate) await this.learnFromGate(id, how.gate, "approved", {});
      return this.get(id);
    }
    const made = new Map<number, string>();
    const topological = kids.map((_, i) => i).sort((a, b) => kids[a]!.order - kids[b]!.order || a - b);
    for (const i of topological) {
      const kid = kids[i]!;
      const n = i + 1;
      const files = kid.files_hint.length > 0 ? `\n\nFiles:\n${kid.files_hint.map((f) => `- ${f}`).join("\n")}` : "";
      const { task: child, created } = await this.createTaskOnce(
        {
          title: kid.title,
          description: `Part ${n} of ${kids.length} of card ${id.slice(0, 8)}.\n\n${kid.goal}${files}`,
          criteria: kid.acceptance_criteria,
          repoPath: task.repoPath,
          stages: task.stages,
          noJiraDetection: true,
          originMachine: "automation",
          hints: { size: sizeBucketOf(kid.est_loc) },
          stack: { audience: cardOf(task).audience ?? cardOf(task).sources, splitFrom: id, splitPart: { n, of: kids.length }, dependsOn: kid.depends_on.map((p) => made.get(p - 1)).filter((x): x is string => x !== undefined), startWhenReady: true, riskFloor: floor },
        },
        `split:${open.id}:${n}`,
      );
      made.set(i, child.id);
      if (created) await this.log(child.id, "card.child", { of: id, n, total: kids.length });
    }
    const ids = kids.map((_, i) => made.get(i)!);
    await this.store.updateTask(id, { card: { ...cardOf(task), splitInto: ids } });
    await this.log(id, "card.split", { children: kids.length, via: "cards" });
    await this.archive(id, "split", { onlyFrom: new Set<TaskState>(["awaiting_approval"]), decision: record });
    if (how.gate) await this.learnFromGate(id, how.gate, "approved", {});
    // The children with nothing to wait for start now; the others stay drafts that start when ready.
    for (const child of ids) {
      const row = await this.get(child);
      if ((cardOf(row).dependsOn ?? []).length > 0) continue;
      await this.start(child).catch((error: unknown) => console.error(`could not start part ${child} of ${id}`, error));
    }
    return this.get(id);
  }

  /** The children a split gate made before it was sent back or rejected (keys `split:<gate>:<n>`): still drafts, never started, archived with fixed words. */
  private async archiveSplitLeftovers(originId: string, gate: ApprovalRow): Promise<void> {
    for (let n = 1; n <= 20; n++) {
      const child = await this.store.taskByKey(`split:${gate.id}:${n}`);
      if (!child || child.state !== "draft") continue;
      await this.archive(child.id, "rejected", { onlyFrom: new Set<TaskState>(["draft"]), decision: { decision: "rejected", reason: "the split it came from was not approved: this part is not made" } }).catch((error: unknown) => console.warn(`could not archive part ${child.id} of ${originId}`, error));
    }
  }

  /** A rejection: the plan gate's alone (an open plan, not triage's outcome and not a later gate). The card is archived with reason `rejected`, the comment kept. */
  private async reject(task: TaskRow, reason: string | undefined, auto: boolean): Promise<TaskRow> {
    const gateKind = task.state === "awaiting_approval" || (task.state === "awaiting_ship" && task.route !== "review") ? task.state : null;
    const open = gateKind ? (await this.approvals(task.id)).find((a) => a.kind === gateKind && a.decision === null) : undefined;
    // The plan gate, or the watch's release question; the preview gate and every other gate are not rejectable.
    if (!open || auto || (open.requested.outcome !== undefined && !isSplitOutcome(open.requested.outcome)) || (gateKind === "awaiting_ship" && open.requested.gate !== "ship_approval")) throw new RejectNotAllowedError(task.id, task.state);
    const record = { decision: "rejected" as const, ...(reason ? { reason } : {}) };
    const archived = await this.archive(task.id, "rejected", { onlyFrom: new Set<TaskState>([gateKind!]), decision: record });
    if (isSplitOutcome(open.requested.outcome)) await this.archiveSplitLeftovers(task.id, open);
    if (this.truth) await this.learnFromGate(task.id, open, "sent_back");
    // The release question opens only when the checklist passes: rejecting it overrides a ready PR. Ids only; the retro counts it.
    if (gateKind === "awaiting_ship") await this.log(task.id, "ship.override", { kind: "rejected_ready", items: [] });
    return archived;
  }

  /** `decision.truth` on the task's activity: which decision record a later fact settled, and by what (ids only). */
  async logDecisionTruth(taskId: string, fact: { pack: PackId; recordId: string; source: string }): Promise<void> {
    await this.log(taskId, "decision.truth", fact);
  }

  /** What a person's decision at a gate says about the decisions the gate carried: the plan's three checks (an
   *  approval untouched confirms them, an edit of their subject or a send-back contradicts), the findings a
   *  shipped pack still held, the retro's worth. Never throws: a truth is a bonus, not part of the decision. */
  private async learnFromGate(taskId: string, gate: ApprovalRow, decision: "approved" | "sent_back", response?: Record<string, unknown>): Promise<void> {
    const truth = this.truth;
    if (!truth) return;
    try {
      const requested = gate.requested as { decisions?: Record<string, unknown>; outcome?: unknown; revisions?: unknown; rules?: unknown };
      const ids = requested.decisions ?? {};
      const task = await this.get(taskId);
      const recordId = task.classification?.recordId;
      const edited = new Set((task.record?.editedFields ?? []).flatMap((f) => (f === "kind" ? ["kind"] : f === "typeOfWork" ? ["type_of_work"] : f === "size" ? ["size"] : f === "riskPrelim" ? ["risk_prelim"] : [])));
      const edits = task.record ? triageEditTruth(task.record) : {};
      if (gate.kind === "awaiting_approval" && recordId && (requested.outcome === "conversation" || requested.outcome === "archive")) {
        await truth.learned({ pack: "triage_signals", recordId, label: { ...edits, ...triageOutcomeTruth(requested.outcome, decision) }, kind: "person", source: decision === "sent_back" ? "triage_sent_back" : "triage_outcome_approved", taskId });
      } else if (gate.kind === "awaiting_approval" && requested.outcome === undefined && recordId && decision === "approved" && task.classification) {
        // An approval that left the signals alone confirms the ones the machine acted on; a correction stands in for its own question.
        const policy = await this.policyFor(task.repoPath);
        const verdicts = triageVerdicts(task.classification, policy.factory.triage, { ...(policy.decisions.triage_signals ? { overrides: policy.decisions.triage_signals } : {}) });
        await truth.learned({ pack: "triage_signals", recordId, label: { ...triageConfirmTruth(task.classification, verdicts, edited), ...edits }, kind: "person", source: "plan_approved", taskId });
      }
      if (gate.kind === "awaiting_approval" && isSplitOutcome(requested.outcome)) {
        // A split approved as proposed confirms split_check; sent back, rejected or kept whole contradicts it.
        const recordId = ids.split_check;
        if (typeof recordId === "string") {
          const kept = response?.keepWhole === true;
          const confirmed = decision === "approved" && !kept;
          const answer = await truth.answerOf("split_check", recordId);
          const label = answer ? planTruth(PACKS.split_check, answer, confirmed ? "confirmed" : "contradicted") : null;
          if (label) await truth.learned({ pack: "split_check", recordId, label, kind: "person", source: confirmed ? "split_approved" : kept ? "split_kept_whole" : "split_sent_back", taskId });
        }
      } else if (gate.kind === "awaiting_approval" && requested.outcome === undefined) {
        const touched = new Set((Array.isArray(requested.revisions) ? requested.revisions : []).flatMap((r) => Object.keys((r as { after?: object }).after ?? {})));
        const subject: Record<string, string[]> = { coverage_check: ["cases"], plan_check: ["brief", "criteria", "assumptions", "slices", "rollback"], risk_score: ["risk"] };
        for (const [pack, keys] of Object.entries(subject)) {
          const recordId = ids[pack];
          if (typeof recordId !== "string") continue;
          const answer = await truth.answerOf(pack as PackId, recordId);
          const contradicted = decision === "sent_back" || keys.some((key) => touched.has(key));
          const label = answer ? planTruth(PACKS[pack as "coverage_check" | "plan_check" | "risk_score"], answer, contradicted ? "contradicted" : "confirmed") : null;
          if (label) await truth.learned({ pack: pack as PackId, recordId, label, kind: "person", source: decision === "sent_back" ? "plan_sent_back" : contradicted ? "plan_edited" : "plan_approved", taskId });
        }
      } else if (gate.kind === "awaiting_ship" && decision === "approved" && Array.isArray(ids.finding_classify)) {
        for (const recordId of ids.finding_classify) if (typeof recordId === "string") await truth.learned({ pack: "finding_classify", recordId, label: findingTruth(), kind: "person", source: "ship_approved", taskId });
      } else if (gate.kind === "reviewing_memory" && typeof ids.worth_learning === "string" && requested.rules && typeof requested.rules === "object") {
        const kept = decision === "approved" && response?.applyRules !== false;
        await truth.learned({ pack: "worth_learning", recordId: ids.worth_learning, label: worthLearningTruth(kept), kind: "person", source: kept ? "retro_approved" : "retro_closed", taskId });
      }
    } catch (error) {
      console.warn(`decision truth: gate ${gate.kind} of task ${taskId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Writes the plan gate that was just approved as ground truth; whatever goes wrong is an event, never an error. */
  private async keepGroundTruth(task: TaskRow, approvalId: string): Promise<void> {
    if (!this.groundTruth || !(await this.truthKept(task))) return;
    try {
      const approval = (await this.approvals(task.id)).find((a) => a.id === approvalId);
      if (!approval || approval.decision !== "approved") return;
      await this.log(task.id, "ground_truth.written", { path: await this.groundTruth(task, approval) });
    } catch (error) {
      await this.log(task.id, "ground_truth.failed", { error: error instanceof Error ? error.message : String(error) }).catch(() => {});
    }
  }

  /** A person resumed the card and never corrected the reason the machine decided: that confirms it, as an outcome (a later correction, or a correction already made, outranks it). Never throws. */
  private async confirmEscalationReason(id: string, gate: ApprovalRow): Promise<void> {
    try {
      if (!this.truth) return;
      const decided = objectOf(gate.requested.escalationDecision);
      if (typeof decided?.recordId !== "string" || typeof decided.reason !== "string") return;
      if ((await this.events(id)).some((e) => e.kind === "escalation.corrected" && e.payload.approval === gate.id)) return;
      const derived = escalationResumedTruth(decided.reason);
      await this.truth.learned({ pack: "escalation_reason", recordId: decided.recordId, label: derived.label, kind: derived.kind, source: derived.source, taskId: id });
    } catch {
      // Ground truth never blocks a resume.
    }
  }

  /** Records what a person did on the branch after an escalation (commits since, names and line counts) beside the decision, with the reason they corrected it to. */
  private async keepEscalationTruth(task: TaskRow, approvalId: string): Promise<void> {
    if (!this.escalationTruth || !(await this.truthKept(task))) return;
    try {
      const approval = (await this.approvals(task.id)).find((a) => a.id === approvalId);
      if (!approval) return;
      const corrected = (await this.events(task.id)).findLast((e) => e.kind === "escalation.corrected" && e.payload.approval === approvalId)?.payload.to;
      const since = approval.requested.headSha;
      const commits = task.worktreePath && this.commitsSince && typeof since === "string" && /^[0-9a-f]{7,64}$/.test(since) ? await this.commitsSince(task.worktreePath, since).catch((): CommitFact[] => []) : [];
      await this.log(task.id, "ground_truth.written", { path: await this.escalationTruth(task, approval, commits, typeof corrected === "string" ? corrected : null) });
    } catch (error) {
      await this.log(task.id, "ground_truth.failed", { error: error instanceof Error ? error.message : String(error) }).catch(() => {});
    }
  }

  /** A person corrects the reason Build's escalation was decided with (the enum only). The correction labels the `escalation_reason` record; it never moves a card that already waits for a person. */
  async correctEscalationReason(id: string, reason: string): Promise<TaskRow> {
    const task = await this.get(id);
    const gate = task.state === "escalated" ? (await this.approvals(id)).find((a) => a.kind === "escalated" && a.decision === null) : undefined;
    if (!gate) throw new NoEscalationToCorrectError(id);
    if (!(DECIDED_REASONS as readonly string[]).includes(reason)) throw new InvalidEscalationReasonError();
    const decided = objectOf(gate.requested.escalationDecision);
    await this.log(id, "escalation.corrected", { from: typeof decided?.reason === "string" ? decided.reason : null, to: reason, approval: gate.id });
    if (this.truth && typeof decided?.recordId === "string") await this.truth.learned({ pack: "escalation_reason", recordId: decided.recordId, label: { reason: { choice: reason } }, kind: "person", source: "escalation_correction", taskId: id });
    return task;
  }

  /** Stops the running (or merely queued) stage and waits for you. */
  async abort(id: string): Promise<TaskRow> {
    // The notch's Stop at a gate ends the run there (RFC 0004); a board task at a gate is a 409, as always.
    const before = await this.get(id);
    if (before.source?.kind === "notch" && before.state.startsWith("awaiting_")) {
      return this.dispatch(id, { type: "stop" }, { decision: { decision: "sent_back", reason: "stopped" } });
    }
    // A state that holds a stage or a gate is aborted only while it runs a stage: with an open approval it is a gate, a 409 like any other.
    if (RUN_OR_GATE.has(before.state) && !(await this.runsAStage(before))) throw new TransitionError(before, { type: "abort" });
    const task = await this.dispatch(id, { type: "abort" });
    this.loops.get(id)?.abort();
    await this.store.updateTask(id, { queued: false });
    clearTimeout(this.resumeTimers.get(id));
    this.resumeTimers.delete(id);
    // The task reads "escalated" from here on, but the stage is still dying: its container
    // being killed, its run recorded, its worktree reset. Return once that is over, so a
    // retry or a delete that follows this call never shares the worktree with a live container.
    if (!(await this.untilLoopEnds(id, ABORT_WIND_DOWN_MS))) return task;
    return (await this.store.getTask(id)) ?? task;
  }

  /** Ends the task as archived, with a reason, from any state that has not ended (or only from
   *  `onlyFrom`, for a caller that decided on a listed row). The row ends first, under its lock;
   *  a running stage is then stopped and waited out; only then do the close steps run, so the
   *  worktree is never removed under a container that still has it. */
  async archive(id: string, reason: ArchiveReason, options: { onlyFrom?: ReadonlySet<TaskState>; decision?: DecisionRecord } = {}): Promise<TaskRow> {
    const step = await this.apply(id, { type: "archive", reason }, { onlyFrom: options.onlyFrom, ...(options.decision ? { decision: options.decision } : {}) });
    this.loops.get(id)?.abort();
    await this.store.updateTask(id, { queued: false });
    clearTimeout(this.resumeTimers.get(id));
    this.resumeTimers.delete(id);
    await this.untilLoopEnds(id, ABORT_WIND_DOWN_MS);
    if (step.effect.kind === "done") await this.close(id);
    return this.get(id);
  }

  /** True once id's stage loop has let go of its slot, false if it has not within `ms`. */
  private async untilLoopEnds(id: string, ms: number): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (this.loops.has(id)) {
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return true;
  }

  /** Stops every running stage (killing its container) and waits for them to wind down, so a
   *  normal Ctrl+C does not leave a container or a dirty worktree running unseen. Under the
   *  `requeue` policy the tasks go back to the queue, state kept, and recover() re-runs the
   *  stage on the next boot; under `escalate` they wait for you, as an abort does. */
  async shutdown(): Promise<void> {
    this.stopping = true;
    this.stopSupervisor();
    const ids = [...this.loops.keys()];
    await Promise.all(
      ids.map((id) =>
        (this.restartPolicy === "requeue" ? this.park(id) : this.abort(id)).catch((error: unknown) =>
          console.error(`could not stop task ${id} on shutdown`, error),
        ),
      ),
    );
    const deadline = Date.now() + 5000;
    while (this.loops.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  /** Back to the queue with its state kept: the stage is cut short (its run ends `aborted`, the
   *  worktree reset as any failed attempt's is) and runs again from the top on the next boot. */
  private async park(id: string): Promise<void> {
    await this.enqueue(id);
    await this.log(id, "task.parked", { reason: "machine shutting down; the stage re-runs on the next boot" });
    this.loops.get(id)?.abort();
  }

  /** Epoch ms until which some credential's claims are held because a stage hit its usage limit
   *  (the latest such time); null when every window is open. */
  get latchedUntil(): number | null {
    const open = this.openLatches();
    return open.length > 0 ? Math.max(...open.map(([, until]) => until)) : null;
  }

  /** The credentials whose window is latched right now, with until when. */
  private openLatches(): Array<[CredentialOwner, number]> {
    const now = Date.now();
    return [...this.latches].filter(([, until]) => until > now);
  }

  /** Holds `owner`'s queued work until `until`, or longer if it is already held longer. */
  private latch(owner: CredentialOwner, until: number): void {
    if (until > Date.now()) this.latches.set(owner, Math.max(this.latches.get(owner) ?? 0, until));
  }

  /** The window `id` paused on is open again; with no record of which (it paused before a
   *  restart and was never seen paused since), every window is. */
  private unlatch(id: string): void {
    const owner = this.pausedOn.get(id);
    this.pausedOn.delete(id);
    if (owner) this.latches.delete(owner);
    else this.latches.clear();
  }

  /** The engine `stage` would run on for `task` right now, picked as the pack runner picks it;
   *  null for a stage that runs no pack. */
  private async engineFor(task: TaskRow, stage: TaskState): Promise<EngineId | null> {
    const pack = packForState(stage);
    if (!pack) return null;
    const { engines } = await this.policies.for(task.repoPath);
    return (await pickEngine(this.credentials, PACKS[pack], task.stages ?? null, engines ?? null, task.repoPath)).engine;
  }

  /** Whose window `stage` would spend for `task`. A stage with no pack of its own counts as
   *  Claude's, as every stage did before engines: the loop goes on to the next Claude stage. */
  private async ownerFor(task: TaskRow, stage: TaskState): Promise<CredentialOwner> {
    const engine = await this.engineFor(task, stage);
    return engine ? credentialOwner(engine) : "claude";
  }

  /** Whose window the latest run of `stage` spent: the engine it started on, else the one it would pick. */
  private async spentOn(task: TaskRow, stage: TaskState): Promise<{ owner: CredentialOwner; engine: EngineId | null }> {
    const run = (await this.store.listStageRuns(task.id)).findLast((r) => r.stage === stage);
    const engine = run?.engine ?? (await this.engineFor(task, stage));
    return { owner: engine ? credentialOwner(engine) : "claude", engine };
  }

  /** After `stage` hit a usage limit: the pack's next fallback engine that has not run it this time,
   *  whose window is open and whose credential this machine has, else null. When there is one,
   *  the window just hit is latched here (the pause does it otherwise), so the queue waits on it. */
  private async fallbackAfterLimit(id: string, stage: TaskState, tried: Set<EngineId>, resetsAt: unknown): Promise<{ engine: EngineId; reason: string } | null> {
    const pack = packForState(stage);
    if (!pack || !PACKS[pack].engines.fallback?.length) return null;
    const task = await this.get(id);
    const { owner, engine } = await this.spentOn(task, stage);
    if (!engine) return null;
    tried.add(engine);
    const held = new Set([owner, ...this.openLatches().map(([latched]) => latched)]);
    let next: EngineId | null = null;
    for (const candidate of fallbackCandidates(PACKS[pack], tried)) {
      if (held.has(credentialOwner(candidate))) continue;
      if ((await this.credentials.check(candidate, { repo: task.repoPath })).available) {
        next = candidate;
        break;
      }
    }
    if (!next) return null;
    const at = resetSeconds(resetsAt);
    this.latch(owner, at !== null ? at * 1000 + RESUME_MARGIN_MS : Date.now() + LATCH_FALLBACK_MS);
    const until = this.latches.get(owner);
    await this.log(id, "usage.latched", { owner, engine, until: until ? new Date(until).toISOString() : null });
    return { engine: next, reason: `fallback after ${engine} rate limit` };
  }

  /** True when a credential's window is latched and `stage` of the task would spend it. */
  private async heldForUsage(id: string, stage: TaskState): Promise<boolean> {
    const latched = new Set(this.openLatches().map(([owner]) => owner));
    if (latched.size === 0) return false;
    const task = await this.store.getTask(id);
    return task !== null && latched.has(await this.ownerFor(task, stage));
  }

  /** The queued tasks whose next stage would spend a credential whose window is latched. */
  private async heldByUsage(): Promise<Set<string>> {
    const held = new Set<string>();
    const latched = new Set(this.openLatches().map(([owner]) => owner));
    if (latched.size === 0) return held;
    for (const task of (await this.store.listTasks()).filter((t) => t.queued)) {
      if (latched.has(await this.ownerFor(task, task.state))) held.add(task.id);
    }
    return held;
  }

  /** Latches live in memory: after a restart, each paused task's window is held again until its
   *  reset (or the fallback after its pause, when it named none). */
  private async relatch(): Promise<void> {
    for (const task of await this.store.findStuckTasks(new Set<TaskState>(["paused_rate_limit"]))) {
      const stage = task.resumeTo ?? task.state;
      const finished = await this.store.findFinishedEvents(task.id);
      const { owner } = await this.spentOn(task, stage);
      this.pausedOn.set(task.id, owner);
      // The runs that hit a limit before the pause, newest first: the one it paused on and those
      // it fell back from. Each holds its own engine's window until that run's reset.
      const runs = (await this.store.listStageRuns(task.id)).filter((run) => run.stage === stage).reverse();
      const firstOk = runs.findIndex((run) => run.outcome !== "rate_limited");
      const limited = runs.slice(0, firstOk === -1 ? runs.length : Math.max(1, firstOk));
      if (limited.length === 0) {
        this.latchFrom(owner, finished[0]);
        continue;
      }
      for (const run of limited) {
        this.latchFrom(run.engine ? credentialOwner(run.engine) : owner, finished.find((event) => event.stageRunId === run.id) ?? finished[0]);
      }
    }
  }

  /** Latches `owner` until the reset a run's `stage.finished` named, or the fallback after it. */
  private latchFrom(owner: CredentialOwner, finished: EventRow | undefined): void {
    const at = resetSeconds((finished?.payload.detail as Record<string, unknown> | undefined)?.resetsAt);
    this.latch(owner, at !== null ? at * 1000 + RESUME_MARGIN_MS : (finished?.at.getTime() ?? 0) + LATCH_FALLBACK_MS);
  }

  /** Runs tick() every `intervalMs` until stopSupervisor(). */
  startSupervisor(intervalMs: number): void {
    this.stopSupervisor();
    this.supervisor = setInterval(() => {
      this.tick().catch((error: unknown) => console.error("supervisor tick failed", error));
    }, intervalMs);
    this.supervisor.unref();
  }

  stopSupervisor(): void {
    clearInterval(this.supervisor);
    this.supervisor = undefined;
  }

  /**
   * The supervisor: one periodic pass that catches what event-driven scheduling misses.
   * A running task nobody is driving is escalated (a crash that never reached the catch, a
   * restart, a lost claim); a paused task without a timer gets one back; then free slots
   * are filled from the queue, unless a usage window is latched.
   */
  async tick(): Promise<void> {
    const cutoff = Date.now() - ORPHAN_GRACE_MS;
    for (const task of await this.stuckRunning()) {
      if (task.queued || this.loops.has(task.id) || task.updatedAt.getTime() > cutoff) continue;
      await this.apply(task.id, { type: "crash", error: "no stage loop was driving it" }, {}).catch((error: unknown) =>
        console.error(`could not escalate orphaned task ${task.id}`, error),
      );
    }
    await this.rearmPaused();
    await this.autoApprovePlans();
    await this.releaseHeld();
    await this.probeShipGates();
    await this.fillSlots();
  }

  private readonly shipProbedAt = new Map<string, number>();

  /** An open release question is looked at against GitHub, at most once per interval: a PR merged on GitHub closes it as an automatic approval (no name
   *  asked, no ground truth written); a head that moved or a checklist that no longer passes withdraws it, and the watch runs again. A probe that fails leaves it open. */
  private async probeShipGates(): Promise<void> {
    const probe = this.shipGateProbe;
    if (!probe) return;
    for (const task of await this.store.findStuckTasks(new Set<TaskState>(["awaiting_ship"]))) {
      if (task.route !== "feature") continue;
      const gate = (await this.store.listApprovals(task.id)).find((a) => a.kind === "awaiting_ship" && a.decision === null && a.requested.gate === "ship_approval");
      if (!gate) {
        this.shipProbedAt.delete(task.id);
        continue;
      }
      const last = this.shipProbedAt.get(task.id);
      // A machine-wide interval (`MACHINE_SHIP_POLL_INTERVAL`) wins; else the repository's `ship.poll_minutes`.
      const every = this.shipProbeMs ?? (await this.policyFor(task.repoPath)).factory.ship.poll_minutes * 60_000;
      if (last !== undefined && Date.now() - last < every) continue;
      this.shipProbedAt.set(task.id, Date.now());
      try {
        const seen = await probe(task, gate);
        if (seen === "merged") await this.dispatch(task.id, { type: "approved", gate: "ship_approval" }, { decision: { decision: "approved", reason: "merged on GitHub", response: { auto: true } }, onlyFrom: new Set<TaskState>(["awaiting_ship"]) });
        else if (seen === "closed") await this.archive(task.id, "pr_closed", { onlyFrom: new Set<TaskState>(["awaiting_ship"]) });
        else if (seen === "withdraw") await this.dispatch(task.id, { type: "sent_back", from: "plan", gate: "ship_approval" }, { decision: { decision: "sent_back", reason: "the PR changed: asked again when it is ready" }, onlyFrom: new Set<TaskState>(["awaiting_ship"]) });
      } catch (error) {
        console.error(`could not probe the release question of task ${task.id}`, error);
      }
    }
  }

  /** A plan that has waited the repo's `auto_approve_plan_minutes` is approved by itself when
   *  triage reported high confidence and low risk and asked nothing. Anything less waits for you,
   *  and a notch task always does: the machine never moves a notch card into Approved (RFC 0004). */
  private async autoApprovePlans(): Promise<void> {
    for (const task of await this.store.findStuckTasks(new Set<TaskState>(["awaiting_approval"]))) {
      // A Luna Notch task's plan is the notch's to approve (its AutoApproval calls /decision).
      if (task.source?.kind === "notch") continue;
      const { autoApprovePlanMinutes: minutes } = await this.policies.for(task.repoPath);
      if (minutes === null) continue;
      const open = (await this.store.listApprovals(task.id)).find((a) => a.kind === "awaiting_approval" && a.decision === null);
      if (!open) continue;
      // A reply or an archive waits for a person's tap, whatever else the gate carries: nothing outward is ever sent by a clock.
      if (open.requested.outcome === "conversation" || open.requested.outcome === "archive") continue;
      // Nor is a split ever approved by a clock: a person reads the children (or the reason there are none) first.
      if (isSplitOutcome(open.requested.outcome)) continue;
      // Low risk, every check a clear yes, and nothing asked: the plan stage's own findings are the bar.
      // A plan that came back with evidence, or that carries any flag, is a person's to read: the clock never approves it.
      if (open.requested.replan !== undefined || (Array.isArray(open.requested.flagged) && open.requested.flagged.length > 0)) continue;
      const { risk, verdicts, questions } = open.requested as { risk?: { level?: unknown }; verdicts?: Record<string, unknown>; questions?: unknown };
      const checks = Object.values(verdicts ?? {});
      if (risk?.level !== "low" || checks.length === 0 || checks.some((verdict) => verdict !== "proceed") || (Array.isArray(questions) && questions.length > 0)) continue;
      if (Date.now() - open.createdAt.getTime() < minutes * 60_000) continue;
      const reason = `auto-approved after ${minutes} min: low risk and every check proceeded`;
      await this.log(task.id, "plan.auto_approved", { reason });
      await this.decide(task.id, "approved", reason, undefined, { auto: true }).catch((error: unknown) =>
        console.error(`could not auto-approve the plan of task ${task.id}`, error),
      );
    }
  }

  /** The usage window has reset: re-run the stage the task paused in. */
  windowReset(id: string): Promise<TaskRow> {
    clearTimeout(this.resumeTimers.get(id));
    this.resumeTimers.delete(id);
    // A reset, from the timer or from you, is the word that the window is open again.
    this.unlatch(id);
    return this.dispatch(id, { type: "window_reset" });
  }

  /**
   * After a restart no stage loop is running. A task that was actually mid-container-run
   * when the machine stopped is escalated, so you decide whether to re-run the stage; one
   * that was merely queued for a free slot lost nothing and is simply rescheduled.
   */
  async recover(): Promise<number> {
    const stuck = await this.stuckRunning();
    // A stage container the last machine started may still be running: re-attach to it and
    // ingest its result when it ends, rather than kill it and ask you whether to start over.
    const resumable = new Map<string, StageRunRow>();
    for (const task of stuck) {
      if (task.queued) continue;
      const run = (await this.store.listStageRuns(task.id)).findLast((r) => r.status === "running" && r.stage === task.state);
      if (run?.containerId && (await this.containerRunning(run.containerId))) resumable.set(task.id, run);
    }
    await this.store.markRunningStageRunsAborted([...resumable.values()].map((r) => r.id));
    let escalated = 0;
    for (const task of stuck) {
      const run = resumable.get(task.id);
      if (task.queued) {
        await this.schedule(task.id, task.state);
      } else if (run) {
        const controller = this.reserveSlot(task.id, task.state);
        await this.log(task.id, "stage.reattached", { stage: task.state, container: run.containerId }, run.id);
        const loop = this.startLoop(task.id, task.state, controller, {
          runId: run.id,
          attempt: run.attempt,
          container: run.containerId!,
          inputCommit: run.inputCommit,
          engine: run.engine,
        });
        if (this.inline) await loop;
      } else if (HOST_POLLERS.has(task.state)) {
        // ci_watch and shipping run on the host, hold no container and are idempotent (the monitor's cursor is on disk):
        // a restart runs them again rather than asking a person.
        const dead = (await this.store.listStageRuns(task.id)).findLast((r) => r.status === "running" && r.stage === task.state);
        if (dead) await this.store.markRunningStageRunsAborted([dead.id]);
        await this.log(task.id, "stage.restarted", { stage: task.state, reason: "the machine restarted mid-stage" }, dead?.id);
        const controller = this.reserveSlot(task.id, task.state);
        const loop = this.startLoop(task.id, task.state, controller);
        if (this.inline) await loop;
      } else {
        const dead = (await this.store.listStageRuns(task.id)).findLast((r) => r.stage === task.state && r.containerId);
        if (dead?.containerId) await this.removeContainer(dead.containerId).catch(() => {});
        await this.apply(task.id, { type: "abort" }, { detail: { note: "the machine restarted mid-stage" } });
        escalated++;
      }
    }
    await this.relatch();
    await this.rearmPaused();
    return escalated;
  }

  /** Resume timers live in memory, so a restart during a usage window would otherwise park
   *  every paused task until someone clicks resume. Re-arm from the pause's own reset time. */
  private async rearmPaused(): Promise<void> {
    for (const task of await this.store.findStuckTasks(new Set<TaskState>(["paused_rate_limit"]))) {
      if (this.resumeTimers.has(task.id)) continue;
      const latest = (await this.store.findFinishedEvents(task.id))[0];
      const detail = latest?.payload.detail as Record<string, unknown> | undefined;
      const at = resetSeconds(detail?.resetsAt);
      if (at === null) continue;
      if (at * 1000 <= Date.now()) {
        await this.windowReset(task.id).catch((error: unknown) => console.error(`could not resume task ${task.id}`, error));
      } else {
        this.scheduleResume(task.id, at);
      }
    }
  }

  /** Claims queued tasks into free slots, oldest first, until the pool is full or the queue is
   *  empty, skipping tasks whose next stage would spend a latched usage window. The one place a
   *  slot is ever filled from the queue. */
  /** Into the queue, stamped: claims go by this time, so an edit while waiting keeps the place. */
  private enqueue(id: string): Promise<void> {
    return this.store.updateTask(id, { queued: true, queuedAt: new Date() });
  }

  private async fillSlots(): Promise<void> {
    while (!this.stopping && !this.draining && this.active() < this.maxConcurrentTasks) {
      if (await this.dayOver()) return;
      const claimed = await this.store.claimNextQueuedTask({
        running: RUNNING,
        maxPerRepo: this.maxPerRepo,
        maxPerStage: this.maxPerStage,
        repoCaps: await this.repoCaps(),
        excludeRepos: await this.reposOverMonth(),
        excludeTasks: await this.heldByUsage(),
      });
      if (!claimed) return;
      // shutdown() may have begun while this pass awaited the claim: put the task back, its
      // place kept, rather than start a stage nothing will stop (shutdown stops the loops it saw).
      if (this.stopping) {
        await this.store.updateTask(claimed.id, { queued: true });
        return;
      }
      const controller = this.reserveSlot(claimed.id, claimed.state);
      const loop = this.startLoop(claimed.id, claimed.state, controller);
      if (this.inline) await loop;
    }
  }

  /** Each queued repo's own cap from its PIPELINE.md, where it sets one. */
  private async repoCaps(): Promise<Map<string, number>> {
    const caps = new Map<string, number>();
    const queued = (await this.store.listTasks()).filter((t) => t.queued && t.repoPath);
    for (const repo of new Set(queued.map((t) => t.repoPath!))) {
      const { maxConcurrent } = await this.policies.for(repo);
      if (maxConcurrent !== null) caps.set(repo, maxConcurrent);
    }
    return caps;
  }

  stageRuns(id: string): Promise<StageRunRow[]> {
    return this.store.listStageRuns(id);
  }

  /** When each task's running stage run started, for every task that has one, in one query. */
  runningStageStarts(): Promise<Map<string, Date>> {
    return this.store.runningStageStarts();
  }

  approvals(id: string): Promise<ApprovalRow[]> {
    return this.store.listApprovals(id);
  }

  artifacts(id: string): ReturnType<TaskStore["listArtifacts"]> {
    return this.store.listArtifacts(id);
  }

  events(id: string): Promise<EventRow[]> {
    return this.store.listEvents(id);
  }

  /** Applies an event and, if it starts a stage, runs it now or queues it for a free slot. */
  private async dispatch(id: string, event: PipelineEvent, extra: Extra = {}): Promise<TaskRow> {
    const before = await this.get(id);
    // Approving the context gate gives it nothing: the card is checked again, and goes on only when it is complete.
    if (before.state === "awaiting_setup" && event.type === "approved" && (await this.approvals(id)).some((a) => a.decision === null && a.requested.kind === "context")) return this.provideContext(id, {});
    // Approving the dedup gate is "neither": the card is not a duplicate and goes on.
    if (before.state === "awaiting_setup" && event.type === "approved" && (await this.approvals(id)).some((a) => a.decision === null && a.requested.kind === "dedup")) return this.answerDedup(id, { choice: "neither" });
    // Approving the setup gate writes the file first: if that fails the task stays at the gate.
    if (before.state === "awaiting_setup" && event.type === "approved") await this.writeApprovedConfig(before);
    const step = await this.apply(id, event, extra);
    if (step.effect.kind === "run") {
      await this.schedule(id, step.effect.stage);
    }
    if (step.effect.kind === "done") await this.close(id);
    return this.get(id);
  }

  /** The luna.yaml the open setup gate proposes, into the checkout, logged. */
  private async writeApprovedConfig(task: TaskRow): Promise<void> {
    const open = (await this.approvals(task.id)).find((a) => a.kind === "awaiting_setup" && a.decision === null);
    const text = open?.requested.config;
    if (!task.repoPath || typeof text !== "string") throw new Error("no proposed luna.yaml to write");
    await this.writeConfig(task.repoPath, text);
    await this.log(task.id, "config.written", { path: join(task.repoPath, CONFIG_FILE), bytes: text.length });
  }

  /** The memory review's proposal and whether the approval kept it, if the gate carried one. */
  private async approvedRules(id: string): Promise<{ markdown: string; apply: boolean; proposals?: Array<{ kind: string; title: string; body: string }>; factPromotions?: Array<{ id: string; text: string; section: string }> } | undefined> {
    const gate = (await this.approvals(id)).filter((a) => a.kind === "reviewing_memory" && a.decision === "approved").at(-1);
    const rules = (gate?.requested as { rules?: { markdown?: unknown; proposals?: unknown; factPromotions?: unknown } } | undefined)?.rules;
    const promotions = Array.isArray(rules?.factPromotions) ? (rules.factPromotions as Array<{ id: string; text: string; section: string }>).filter((p) => typeof p?.id === "string" && typeof p.text === "string" && typeof p.section === "string") : [];
    const markdown = typeof rules?.markdown === "string" ? rules.markdown : "";
    if (!gate || (markdown.trim() === "" && promotions.length === 0)) return undefined;
    const proposals = Array.isArray(rules?.proposals) ? (rules.proposals as Array<{ kind: string; title: string; body: string }>).filter((p) => typeof p?.kind === "string" && typeof p.title === "string" && typeof p.body === "string") : [];
    return { markdown, apply: gate.response?.applyRules !== false, ...(proposals.length > 0 ? { proposals } : {}), ...(promotions.length > 0 ? { factPromotions: promotions } : {}) };
  }

  /** A merged card's retro: the truth file for the eval loop (written whether or not a retro ran) and the graph misses the Build Report also declared. Returns how many misses were recorded. Never throws. */
  private async recordRetroOutputs(id: string, repoPath: string | null, adopted: boolean): Promise<number> {
    const out = this.retroOutputs;
    if (!out || !(await this.mergedPr(id))) return 0;
    try {
      const facts = await out.facts(id);
      if (!facts) return 0;
      const detail = (await this.latestStageFinish(id, "reviewing_memory"))?.detail;
      const rules = detail?.rules && typeof detail.rules === "object" ? (detail.rules as { recalibration?: unknown; graphMisses?: unknown }) : null;
      if (await this.truthKept(await this.get(id))) {
        await writeRetroTruth(out.stateDir, retroTruthOf({ taskId: id, facts, retro: rules, adopted }));
        await this.log(id, "ground_truth.written", { kind: "retro" });
      }
      // The plan's size_estimate said how big the card would be; the merge counted it (lines only: the retro facts hold no file count).
      const sizeRecord = (await this.latestStageFinish(id, "test_design"))?.detail?.decisions;
      const sizeId = sizeRecord && typeof sizeRecord === "object" ? (sizeRecord as Record<string, unknown>).size_estimate : undefined;
      if (this.truth && typeof sizeId === "string") {
        const derived = sizeTruth({ lines: facts.actual.added + facts.actual.removed });
        await this.truth.learned({ pack: "size_estimate", recordId: sizeId, label: derived.label, kind: derived.kind, source: derived.source, taskId: id }).catch(() => false);
      }
      const accepted = acceptedMisses(rules?.graphMisses, (await out.declaredFiles?.(id)) ?? []);
      if (accepted.length > 0 && repoPath && out.graph) {
        await out.graph.recordMisses(repoPath, { task: id, at: new Date().toISOString(), files: accepted });
        return accepted.length;
      }
    } catch (error) {
      console.error(`could not record the retro outputs of ${id}`, error);
    }
    return 0;
  }

  /** The task's PR when the last shipping run ended in a merge (the monitor's `detail.merged`), else null. */
  private async mergedPr(id: string): Promise<{ prUrl: string; number: number } | null> {
    // A card Deliver or CI found already merged never reached shipping: its merge is on that stage's finish row.
    const detail = (await this.latestStageFinish(id, "shipping"))?.detail ?? [(await this.latestStageFinish(id, "delivering"))?.detail, (await this.latestStageFinish(id, "ci_watch"))?.detail].find((d) => d?.alreadyMerged === true);
    return detail?.merged && typeof detail.prUrl === "string" && typeof detail.number === "number" ? { prUrl: detail.prUrl, number: detail.number } : null;
  }

  /** Runs the host-side close step for a task that just closed and logs what it did. Never throws. */
  private async close(id: string): Promise<void> {
    await this.closeOut(id);
    await this.releaseHeld();
    // The proposer is a pack run of minutes: nothing waits on it, and it never throws.
    const tick = this.factTick(id).finally(() => void this.factTicks.delete(tick));
    this.factTicks.add(tick);
  }

  /** The fact-proposer ticks still running after closes. Tests wait on it; nothing else does. */
  private readonly factTicks = new Set<Promise<void>>();
  async factTicksDone(): Promise<void> {
    while (this.factTicks.size > 0) await Promise.all([...this.factTicks]);
  }

  /** A card closed: the economy counts it and, on every few, asks the proposer for facts. Never throws. */
  private async factTick(id: string): Promise<void> {
    const propose = this.proposer?.run;
    if (!propose) return;
    try {
      const repo = (await this.get(id)).repoPath;
      if (repo) await this.economy.cardClosed(repo, id, (await this.policyFor(repo)).factory.economy, propose);
    } catch (error) {
      console.error(`could not tick the fact proposer for ${id}`, error);
    }
  }

  private async closeOut(id: string): Promise<void> {
    await this.releaseKept?.(id).catch((error: unknown) => console.error(`could not release the kept sandbox of ${id}`, error));
    if (!this.closeDeps) return;
    try {
      const task = await this.get(id);
      const report = await closeTask({ ...task, rules: await this.approvedRules(id), merged: await this.mergedPr(id) }, this.closeDeps);
      if (report.worktreeRemoved) {
        await this.store.updateTask(id, { worktreePath: null });
      }
      await this.log(id, "task.closed", { ...report });
      // A fact the default branch's project context holds is no longer told to a run; one the retro's PR is waiting to land stays told, and is settled later.
      if (report.promoted?.length && task.repoPath) await this.economy.promoted(task.repoPath, report.promoted);
      if (report.pending?.ids.length && task.repoPath) await this.economy.pending(task.repoPath, report.pending.ids, report.pending.branch);
      // What the retro leaves behind, recorded where it is used (never written into prompts or rules here).
      const rulesWritten = report.steps.some((step) => step.step === "rules" && step.ok && !step.note.startsWith("skipped"));
      const misses = await this.recordRetroOutputs(id, task.repoPath, rulesWritten);
      if (rulesWritten || misses > 0) await this.log(id, "card.learned", { ...(rulesWritten ? { rules: 1 } : {}), ...(misses > 0 ? { misses } : {}) });
    } catch (error) {
      console.error(`could not close task ${id}`, error);
    }
  }

  /**
   * Drives the stage now if a slot is free, otherwise marks the task queued for one. Always
   * waits for that decision (and the `queued` flag) to be stored before returning; only
   * waits for the whole run too in inline mode.
   */
  private async schedule(id: string, stage: TaskState): Promise<void> {
    if (this.stopping || this.draining || this.active() >= this.maxConcurrentTasks) {
      await this.enqueue(id);
      return;
    }
    // The slot is reserved before any await: two schedule() calls racing past the size check
    // above could otherwise both claim the last one. The checks that need the database come
    // after, and give the slot back when they hold the task.
    const controller = this.reserveSlot(id, stage);
    const release = () => {
      if (this.loops.get(id) === controller) this.loops.delete(id);
    };
    if (this.stageAtCap(stage, id)) {
      release();
      await this.enqueue(id);
      await this.log(id, "stage.held", { stage, reason: `${stage} is at its cap of ${this.maxPerStage[stage]}` });
      return;
    }
    try {
      // A stage on a credential whose usage window is latched waits for it with the rest of the queue.
      if (await this.heldForUsage(id, stage)) {
        release();
        await this.enqueue(id);
        return;
      }
      if (await this.heldForDay(id, stage)) {
        release();
        return;
      }
      if (await this.repoAtCap(id)) {
        release();
        await this.enqueue(id);
        return;
      }
      // Clears a stale `queued: true` from before a restart, as well as the common case
      // where it was already false. Awaited here — not inside runAndFillSlot — so the
      // `queued` flag is guaranteed stored before schedule() returns, per its own contract;
      // otherwise recover() (which schedules a task that still reads queued:true) can race
      // a slot freeing elsewhere and have the same task claimed and driven a second time.
      await this.store.updateTask(id, { queued: false });
    } catch (error) {
      // Release the slot reserved above, or a transient failure on this update leaks it
      // for the rest of the process.
      release();
      throw error;
    }
    const loop = this.startLoop(id, stage, controller);
    if (this.inline) await loop;
  }

  /** True when the task's repo already holds its cap's worth of running tasks (the task itself
   *  not counted): the repo's own `max_concurrent` from PIPELINE.md, else `MACHINE_MAX_PER_REPO`. */
  private async repoAtCap(id: string): Promise<boolean> {
    const task = await this.store.getTask(id);
    if (!task) return false;
    const cap = (task.repoPath ? (await this.policies.for(task.repoPath)).maxConcurrent : null) ?? this.maxPerRepo;
    if (cap === null) return false;
    const running = await this.store.findStuckTasks(RUNNING);
    const held = running.filter((t) => t.id !== id && !t.queued && t.repoPath === task.repoPath && this.loops.has(t.id)).length;
    return held >= cap;
  }

  /** Creates and registers a new AbortController for `id` in `this.loops`, synchronously —
   *  before any `await` — so a slot this reserves can never be double-claimed by a
   *  concurrent schedule() call racing to check `this.loops.size` in between. The only path
   *  by which `this.loops` ever gains an entry; `startLoop` below is always paired with it. */
  private reserveSlot(id: string, stage: TaskState): AbortController {
    const controller = new AbortController();
    this.loops.set(id, controller);
    this.stages.set(id, stage);
    return controller;
  }

  /** Starts id's drive-then-promote loop. Not awaited outside inline mode — `.catch` logs a
   *  failure instead of letting it become an unhandled rejection that can crash the process. */
  private startLoop(id: string, stage: TaskState, controller: AbortController, resume?: Resume): Promise<void> {
    return this.runAndFillSlot(id, stage, controller, resume).catch((error: unknown) =>
      console.error(`run loop for task ${id} failed`, error),
    );
  }

  /** Drives the stage, then — once its slot is free again — starts the longest-queued task.
   *  `controller` is already registered in `this.loops` and the task's `queued` flag already
   *  cleared by the caller, synchronously, before any `await` — see schedule(). */
  private async runAndFillSlot(id: string, stage: TaskState, controller: AbortController, resume?: Resume): Promise<void> {
    await this.drive(id, stage, controller, resume);
    await this.fillSlots();
  }

  /** Runs stages one after another until the task waits on you, pauses, closes or is aborted.
   *  `controller` is already registered in `this.loops` by the caller. */
  private async drive(id: string, first: TaskState, controller: AbortController, resume?: Resume): Promise<void> {
    try {
      let stage: TaskState | null = first;
      /** The engines that hit their usage limit on this stage, this time round; and the next one to try. */
      const tried = new Set<EngineId>();
      let fallback: { engine: EngineId; reason: string } | undefined;
      while (stage) {
        this.stages.set(id, stage);
        if (await this.holdForBudget(id, stage)) return;
        // Another loop is already driving this stage at its cap: back to the queue, state kept;
        // the claim skips the stage until one of them moves on.
        if (!resume && this.stageAtCap(stage, id)) {
          await this.enqueue(id);
          await this.log(id, "stage.held", { stage, reason: `${stage} is at its cap of ${this.maxPerStage[stage]}` });
          return;
        }
        // ci_watch polls GitHub for up to 45 minutes, and shipping's monitor for days, and neither
        // computes anything: they give their slot back for that long, and the queue is looked at right away.
        const polling = stage === "ci_watch" || stage === "awaiting_ship" || stage === "shipping";
        if (polling) {
          this.offPool.add(id);
          this.fillSlots().catch((error: unknown) => console.error(`could not fill slots during ${stage}`, error));
        }
        // A too_complex escalation gets one run on the pack's stronger engine, handed over like a usage-limit fallback.
        if (stage === "implementing" && !resume && !fallback && (await this.get(id)).retries.strongerNext) {
          const engine = stronger(PACKS.implementing);
          if (engine) {
            fallback = { engine, reason: "one shot on a stronger engine after too_complex" };
            // One full fresh budget for that run, counted from its own start; the transition grants it once per card.
            await this.log(id, "build.budget_reset", { reason: "the stronger model's one run" });
          }
        }
        let result: StageResult;
        // Build's budget is read before each implementing run, a resumed one included: a spent one escalates the card without another run.
        const spentBefore = stage === "implementing" ? await this.spentBuildBudget(id) : null;
        if (spentBefore) {
          this.offPool.delete(id);
          result = spentBefore;
        } else {
          const named = stage;
          try {
            result = await withTask(id, () => this.runStage(id, named, controller.signal, resume, fallback));
          } finally {
            this.offPool.delete(id);
          }
          // ... and when one ends: a run that would be followed by another does not get one when the budget is spent.
          if (stage === "implementing" && (result.outcome === "fail" || result.outcome === "test_change") && !result.rateLimited) {
            result = (await this.spentBuildBudget(id)) ?? result;
          }
          // A provider's rate limit waits for its reset, clamped to the repo's `build.backoff_minutes`.
          if (stage === "implementing" && result.rateLimited) {
            const limits = (await this.policyFor((await this.get(id)).repoPath)).factory.build;
            const wait = rateLimitWaitMs(resetSeconds(result.detail?.resetsAt), limits);
            result = { ...result, detail: { ...result.detail, resetsAt: Math.floor((Date.now() + wait) / 1000) } };
          }
        }
        resume = undefined;
        fallback = undefined;
        // An abort already moved the task on; this stage's result no longer applies.
        if (controller.signal.aborted) return;
        // GitHub shows the PR closed and not merged (the stage read GitHub's own state, never a comment): the card is archived `pr_closed` here, by the loop
        // that is driving it (`archive()` waits for the loop to end, which would be this one), and the close step runs.
        if ((stage === "shipping" || stage === "awaiting_ship") && result.outcome === "fail" && result.detail?.prClosed === true) {
          const archived = await this.apply(id, { type: "archive", reason: "pr_closed" }, {});
          await this.store.updateTask(id, { queued: false });
          if (archived.effect.kind === "done") await this.close(id);
          return;
        }
        // A merged PR closes the loop: one event the board and the places the task came from react to.
        // The same when Deliver or CI found the card's own PR already merged: the card shipped.
        const shippedEarly = (stage === "delivering" || stage === "ci_watch") && result.outcome === "pass" && result.detail?.alreadyMerged === true && !!result.detail.merged;
        if ((stage === "shipping" && result.outcome === "pass" && result.detail?.merged) || shippedEarly) {
          const shipped = shippedEvent(await this.get(id), result.detail);
          if (shipped) await this.log(id, "ship.merged", shipped);
        }
        // A usage limit on one engine: the stage runs again at once on the pack's next fallback
        // that can run, and the task pauses only once there is none.
        if (result.rateLimited) {
          fallback = (await this.fallbackAfterLimit(id, stage, tried, result.detail?.resetsAt)) ?? undefined;
          if (fallback) continue;
        }
        tried.clear();
        // A second scope red on the same card escalates with the reason the machine knows (undeclared_scope); the first got one fix pass.
        const secondScopeRed = stage === "implementing" && result.outcome === "fail" && result.detail?.scopeRed === true && (await this.scopeReds(id)) >= 2;
        const stuck = result.outcome === "fail" && !secondScopeRed ? await this.stuckReason(id, stage) : null;
        // The loop guard ended the run: the same failure again would be the same loop, so it goes to a person (or the planner) now, not to a retry.
        const stopped = result.outcome === "fail" ? loopStop(result.detail?.error, result.events ?? []) : null;
        // A test_change sends the task back to test_design; verifying's tests, the ones
        // implementing says are wrong, must not stay locked in the branch meanwhile.
        const revertFailed = stage === "implementing" && result.outcome === "test_change" ? await this.undoVerifyingTests(id) : null;
        const planned: PipelineEvent = result.rateLimited
          ? { type: "rate_limited" }
          : secondScopeRed
            ? { type: "stage_done", outcome: "escalated", reason: `the scope check failed twice on this card: ${typeof result.detail?.error === "string" ? result.detail.error.slice(0, 300) : "files or tests outside the plan"}`, escalation: "undeclared_scope" }
          : (stuck ?? stopped ?? revertFailed)
            ? { type: "stage_done", outcome: "escalated", reason: stuck ?? (stopped ? String(result.detail!.error) : revertFailed)! }
            : {
                type: "stage_done",
                outcome: result.outcome,
                ...(typeof result.detail?.reason === "string" ? { reason: result.detail.reason } : {}),
                ...(stage === "triage" && TriageOutcome.safeParse(result.detail?.outcome).success ? { triage: result.detail!.outcome as TriageOutcome } : {}),
                ...(EscalationReason.safeParse(result.detail?.escalation).success ? { escalation: result.detail!.escalation as EscalationReason } : {}),
                // Verify's own run failed with no verdict and no finding: it is asked again, Build has nothing to fix.
                ...(stage === "verifying" && result.outcome === "fail" && result.detail?.runFailed === true && (result.findings ?? []).length === 0 ? { unanswered: true as const } : {}),
                ...(await this.blockerSet(id, stage, result)),
                ...(await this.loopCap(id, stage, result)),
                // The merge that did not happen because the PR is not ready; a fix that changed what a scenario shows (media from a new browser run).
                ...(stage === "shipping" && result.detail?.notReady === true ? { notReady: true as const } : {}),
                ...(shippedEarly ? { merged: true as const } : {}),
                // The retro has something for a person (rules, prompt updates, graph misses): it waits for an answer; otherwise the card closes.
                ...(stage === "reviewing_memory" && result.outcome === "pass" && result.detail?.rules != null ? { proposals: true as const } : {}),
                ...(result.detail?.refresh === "media" || result.detail?.refresh === "verify" ? { refresh: result.detail.refresh } : {}),
                ...(stage === "evidence" ? { preview: (await this.policyFor((await this.get(id)).repoPath)).factory.ship.preview === "on" } : {}),
              };
        // An escalation from Build, the machine's own included, carries a decided reason: a fact where one decides, else the typed decision.
        const decided = stage === "implementing" ? await this.decideBuildEscalation(id, result, planned, { secondScopeRed, stuck: stuck ?? null, loopGuard: stopped }) : null;
        const headSha = decided && this.headOf ? await this.headOf((await this.get(id)).worktreePath ?? "").catch(() => null) : null;
        const next: PipelineEvent = decided ? { type: "stage_done", outcome: "escalated", reason: decided.reasonText, escalation: decided.decision.reason } : planned;
        const detail =
          result.needsInput?.length || result.requested?.length || decided
            ? {
                ...result.detail,
                ...(decided ? { escalationDecision: { reason: decided.decision.reason, confidence: decided.decision.confidence, source: decided.decision.source, agentReason: decided.decision.agentReason, ...(decided.decision.recordId ? { recordId: decided.decision.recordId } : {}) }, summary: decided.decision.summary, outputTail: decided.decision.outputTail, ...(headSha ? { headSha } : {}) } : {}),
                ...(result.needsInput?.length ? { questions: result.needsInput } : {}),
                ...(result.requested?.length ? { actions: result.requested } : {}),
              }
            : result.detail;
        const step = await this.apply(id, next, { detail });
        // The PR is open: a card that waited for this one may start.
        if (stage === "delivering" && result.outcome === "pass") await this.releaseHeld();
        // A retro with nothing to propose (or one that broke) ends the card here: no click, the close step runs.
        if (step.effect.kind === "done") {
          await this.close(id);
          return;
        }
        if (step.effect.kind === "pause") {
          this.scheduleResume(id, result.detail?.resetsAt);
          // One usage window is shared by every stage on the same credential: hold the queued
          // work that would spend it until it resets, or the whole queue would line up to hit
          // the same wall. Work on another credential goes on.
          const at = resetSeconds(result.detail?.resetsAt);
          const { owner, engine } = await this.spentOn(await this.get(id), stage);
          this.pausedOn.set(id, owner);
          this.latch(owner, at !== null ? at * 1000 + RESUME_MARGIN_MS : Date.now() + LATCH_FALLBACK_MS);
          const until = this.latches.get(owner);
          await this.log(id, "usage.latched", { owner, engine, until: until ? new Date(until).toISOString() : null });
        }
        stage = step.effect.kind === "run" ? step.effect.stage : null;
        // Back from polling with the pool now full: the next stage waits for a slot like any
        // queued task, and gets one as soon as a loop ends.
        if (stage && polling && this.active() > this.maxConcurrentTasks) {
          await this.enqueue(id);
          await this.log(id, "slot.waited", { stage, reason: `the pool filled while ${stage} was polling` });
          return;
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`stage loop for task ${id} stopped: ${message}`);
      await this.log(id, "loop.crashed", { error: message }).catch(() => {});
      // Leave the task where you can see it, not "running" with no loop behind it. Fails
      // quietly when the task already moved on (the crash came after its last transition).
      await this.apply(id, { type: "crash", error: message }, {}).catch(() => {});
    } finally {
      if (this.loops.get(id) === controller) {
        this.loops.delete(id);
        this.stages.delete(id);
      }
    }
  }

  /** Before a stage starts: over the task's own ceiling escalates it; over the day's parks it
   *  in the queue, state kept, for the supervisor to pick up once the window has moved on.
   *  True when the stage must not run. */
  private async holdForBudget(id: string, stage: TaskState): Promise<boolean> {
    const { taskUsd, dailyUsd } = this.budget;
    if (taskUsd !== null) {
      const spent = await this.store.taskSpendUsd(id);
      if (spent >= taskUsd) {
        await this.apply(id, { type: "over_budget", reason: `budget: task spent ${usd(spent)} of ${usd(taskUsd)}` }, {});
        return true;
      }
    }
    if (await this.heldForRepoMonth(id, stage)) return true;
    return this.heldForDay(id, stage);
  }

  /** Over the repo's monthly ceiling (its PIPELINE.md): the task waits in the queue, state
   *  kept, and the queue skips the repo until the month moves on or the ceiling is raised. */
  private async heldForRepoMonth(id: string, stage: TaskState): Promise<boolean> {
    const task = await this.store.getTask(id);
    if (!task?.repoPath) return false;
    const { monthlyBudgetUsd } = await this.policies.for(task.repoPath);
    if (monthlyBudgetUsd === null) return false;
    const spent = await this.repoSpentThisMonthUsd(task.repoPath);
    if (spent < monthlyBudgetUsd) return false;
    await this.enqueue(id);
    await this.log(id, "budget.held", { stage, reason: `budget: ${task.repoPath} spent ${usd(spent)} of ${usd(monthlyBudgetUsd)} this month` });
    return true;
  }

  /** After a run with a cost: each ceiling the spend has crossed a new threshold of, once. */
  private async raiseAlerts(id: string): Promise<void> {
    const task = await this.store.getTask(id);
    if (!task) return;
    const repo = task.repoPath;
    const raise = async (scope: BudgetAlert["scope"], key: string, limitUsd: number | null, spent: () => Promise<number>) => {
      if (limitUsd === null) return;
      const spentUsd = await spent();
      const reached = ALERT_STEPS.filter((pct) => spentUsd >= (limitUsd * pct) / 100);
      const highest = reached.at(-1);
      if (highest === undefined || highest <= (this.alerted.get(key) ?? 0)) return;
      this.alerted.set(key, highest);
      this.onAlert({ scope, taskId: id, repo, pct: highest, spentUsd: Math.round(spentUsd * 100) / 100, limitUsd });
    };
    await raise("task", `task:${id}`, this.budget.taskUsd, () => this.store.taskSpendUsd(id));
    if (repo) {
      const { monthlyBudgetUsd } = await this.policies.for(repo);
      await raise("repo", `repo:${repo}:${monthKey()}`, monthlyBudgetUsd, () => this.repoSpentThisMonthUsd(repo));
    }
    await raise("day", `day:${dayKey()}`, this.budget.dailyUsd, () => this.spentTodayUsd());
  }

  /** Over the day's ceiling: the task waits in the queue, state kept, and says why. */
  private async heldForDay(id: string, stage: TaskState): Promise<boolean> {
    const { dailyUsd } = this.budget;
    if (dailyUsd === null) return false;
    const spent = await this.spentTodayUsd();
    if (spent < dailyUsd) return false;
    await this.enqueue(id);
    await this.log(id, "budget.held", { stage, reason: `budget: ${usd(spent)} spent today of ${usd(dailyUsd)}` });
    return true;
  }

  /** True while a paused task has a resume timer armed. */
  hasResumeTimer(id: string): boolean {
    return this.resumeTimers.has(id);
  }

  /** Re-runs a paused stage shortly after its usage window resets. */
  private scheduleResume(id: string, resetsAt: unknown): void {
    const at = resetSeconds(resetsAt);
    // Without a reset time, `POST /tasks/:id/resume` continues the task.
    if (at === null) return;
    const delay = Math.max(0, at * 1000 - Date.now()) + RESUME_MARGIN_MS;
    clearTimeout(this.resumeTimers.get(id));
    const timer = setTimeout(() => {
      this.resumeTimers.delete(id);
      this.windowReset(id).catch((error: unknown) =>
        console.error(`could not resume task ${id}`, error),
      );
    }, delay);
    timer.unref();
    this.resumeTimers.set(id, timer);
  }

  private async apply(id: string, event: PipelineEvent, extra: Extra): Promise<Step> {
    const { step, logged } = await this.store.withTaskLock(id, async (task, tx) => {
      if (extra.onlyFrom && !extra.onlyFrom.has(task.state)) throw new TaskMovedError(id, task.state, extra.onlyFrom);
      const step = transition(task, event);
      const open = extra.decision ? await tx.findOpenApproval(id) : null;
      await extra.guard?.(open);
      // Approving the plan adopts triage's criteria: the ticket's, refined and added to.
      const planned = task.state === "awaiting_approval" && event.type === "approved" ? open?.requested.criteria : undefined;
      const criteria = Array.isArray(planned) && planned.length > 0 ? planned.map(String) : undefined;
      const logged = await tx.recordEvent({
        taskId: id,
        kind: "transition",
        stageRunId: null,
        payload: {
          event: event.type,
          ...(event.type === "stage_done" ? { outcome: event.outcome } : {}),
          ...(step.escalation ? { escalation: step.escalation } : {}),
          ...(step.archiveReason ? { archiveReason: step.archiveReason } : {}),
          from: task.state,
          to: step.state,
          ...(step.reason ? { reason: step.reason } : {}),
          // A state that holds a stage or a gate says which it is now: this step opened a gate.
          ...(step.effect.kind === "wait" ? { gate: true } : {}),
        },
      });
      // The row says when it entered this state, stamped like the event, so the clocks need no event scan.
      await tx.updateTask(id, {
        state: step.state,
        stateSince: logged.at,
        retries: step.retries,
        resumeTo: step.resumeTo,
        reason: step.reason ?? null,
        archiveReason: step.archiveReason ?? null,
        ...(criteria ? { criteria } : {}),
      });

      if (open && extra.decision) {
        await tx.decideApproval(open, {
          decision: extra.decision.decision,
          reason: extra.decision.reason ?? null,
          response: extra.decision.response ?? null,
        });
      }
      if (step.effect.kind === "wait") {
        await tx.insertApproval({
          taskId: id,
          kind: step.effect.gate,
          requested: { ...extra.detail, ...(BEFORE_BUILD.has(step.effect.gate as TaskState) && cardOf(task).ticketChanged ? { ticketChanged: cardOf(task).ticketChanged } : {}), ...(step.reason ? { reason: step.reason } : {}), ...(step.escalation ? { escalation: step.escalation } : {}) },
        });
      }
      return { step, logged };
    });

    this.onEvent(logged);
    // The questions the machine built from the signals (fixed text, enum values, numbers) go out by themselves as one comment for the card's
    // own source. A question an agent wrote stays on the board until a person taps `p` (`postQuestions`): it may quote what the agent read.
    const asked = extra.detail?.questions;
    if (step.effect.kind === "wait" && step.effect.gate === "awaiting_answers" && Array.isArray(asked) && asked.length > 0 && extra.detail?.questionsBy === "machine") {
      await this.postQuestionsOnce(id, asked as Array<{ question: string; recommended: string | null }>, "machine");
    }
    return step;
  }

  /** Logs the `task.questions` row for these questions unless the task already has one for the same texts (a triage re-run after a crash asks the same). */
  private async postQuestionsOnce(id: string, questions: Array<{ question: string; recommended: string | null }>, by: "machine" | "person"): Promise<boolean> {
    const { body, secret, hash } = questionsComment(questions);
    if ((await this.events(id)).some((e) => e.kind === "task.questions" && e.payload.hash === hash)) return false;
    await this.log(id, "task.questions", { body, secret, hash, by });
    return true;
  }

  /** A person's tap: post the open questions at `awaiting_answers` where the card came from. Idempotent: the same questions are posted once.
   *  Questions that carry a token-shaped string are refused. */
  async postQuestions(id: string): Promise<{ task: TaskRow; posted: boolean }> {
    const task = await this.get(id);
    if (task.state !== "awaiting_answers") throw new NoQuestionsToPostError(id, "the card is not waiting for answers");
    const open = (await this.approvals(id)).find((a) => a.kind === "awaiting_answers" && a.decision === null);
    const questions = (Array.isArray(open?.requested.questions) ? open!.requested.questions : []) as Array<{ question?: unknown; recommended?: unknown }>;
    const clean = questions.flatMap((q) => (typeof q.question === "string" ? [{ question: q.question, recommended: typeof q.recommended === "string" ? q.recommended : null }] : []));
    if (clean.length === 0) throw new NoQuestionsToPostError(id);
    if (questionsComment(clean).secret) throw new QuestionsCarrySecretError(id);
    return { task, posted: await this.postQuestionsOnce(id, clean, "person") };
  }

  /** The latest finished run of a stage for a task, with the detail it ended with. */
  async latestStageFinish(id: string, stage: TaskState): Promise<{ runId: string; detail?: Record<string, unknown> } | null> {
    const finished = await this.store.findFinishedEvents(id);
    const latest = finished.find((event) => event.payload.stage === stage && event.stageRunId);
    if (!latest?.stageRunId) return null;
    const detail = latest.payload.detail;
    return {
      runId: latest.stageRunId,
      ...(detail && typeof detail === "object" ? { detail: detail as Record<string, unknown> } : {}),
    };
  }

  /** The card's numbers: the branch's diff after a writable pass, tests passed/total after verifying. */
  private async recordTriad(id: string, stage: TaskState, status: string, result: StageResult): Promise<void> {
    const patch: Partial<TaskRow> = {};
    if ((stage === "implementing" || stage === "verifying") && status === "passed" && result.workspace?.worktreePath) {
      const task = await this.store.getTask(id);
      const diff = await this.diffStat(result.workspace.worktreePath, task?.repoPath ?? null).catch(() => null);
      if (diff) Object.assign(patch, { diffAdded: diff.added, diffRemoved: diff.removed });
    }
    const results = (result.detail as { results?: unknown } | undefined)?.results;
    if (stage === "verifying" && Array.isArray(results)) {
      const passed = results.filter((r) => (r as { outcome?: string }).outcome === "pass").length;
      Object.assign(patch, { testsPassed: passed, testsTotal: results.length });
    }
    if (Object.keys(patch).length > 0) await this.store.updateTask(id, patch);
  }

  /** Reverts the commit the latest verifying run added (its tests), when it added one. Returns
   *  the escalation reason when the revert fails, else null. */
  private async undoVerifyingTests(id: string): Promise<string | null> {
    const runs = await this.store.listStageRuns(id);
    const verifying = runs.filter((r) => r.stage === "verifying" && r.outputCommit && r.outputCommit !== r.inputCommit).at(-1);
    const task = await this.store.getTask(id);
    if (!verifying?.outputCommit || !task?.worktreePath) return null;
    try {
      await this.revertCommit(task.worktreePath, verifying.outputCommit);
      await this.log(id, "tests.reverted", { commit: verifying.outputCommit, stageRunId: verifying.id });
      return null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `could not revert verifying's tests ${verifying.outputCommit}: ${message}`;
    }
  }

  /** The numbers of the PRs the machine opened for the card (its `pr.opened` rows), oldest first, so a stage can tell that one of them merged. */
  private async recordedPrs(id: string): Promise<number[]> {
    const numbers = (await this.store.listEvents(id)).flatMap((e) => (e.kind === "stage.pr.opened" && Number.isInteger(e.payload.number) ? [e.payload.number as number] : []));
    return [...new Set(numbers)];
  }

  /** What the draft PR's body is fed: the rows of the stages that ran before Deliver. */
  private async prFacts(id: string): Promise<NonNullable<StageContext["prFacts"]>> {
    const [task, runs, events] = await Promise.all([this.get(id), this.store.listStageRuns(id), this.store.listEvents(id)]);
    return prFactsOf(task, runs, events);
  }

  /** The failures the browser run's or CI's loop may have before a person is asked: the repository's `verify.e2e_rounds` or `verify.ci_rounds`. */
  private async loopCap(id: string, stage: TaskState, result: StageResult): Promise<{ loopCap?: number }> {
    if (result.outcome !== "fail" || (stage !== "e2e" && stage !== "ci_watch")) return {};
    const { verify } = (await this.policyFor((await this.get(id)).repoPath)).factory;
    return { loopCap: stage === "ci_watch" ? verify.ci_rounds : verify.e2e_rounds };
  }

  /** What Verify's failure tells the transition about its blocker findings: their set, and the rounds Build may have on one set (`verify.build_rounds`). */
  private async blockerSet(id: string, stage: TaskState, result: StageResult): Promise<{ findingSet?: string; buildRounds?: number }> {
    if (stage !== "verifying" || result.outcome !== "fail") return {};
    const key = blockerSetKey(result.findings ?? []);
    if (!key) return {};
    return { findingSet: key, buildRounds: (await this.policyFor((await this.get(id)).repoPath)).factory.verify.build_rounds };
  }

  /** The stuck detector's attempt-level rule: a stage that just failed for the third time in a
   *  row with the very same error is going nowhere; a human is cheaper than the rest of the
   *  retry cap. Returns the escalation reason, or null when the failures differ. */
  private async stuckReason(id: string, stage: TaskState): Promise<string | null> {
    const finished = await this.store.findFinishedEvents(id);
    const errors: string[] = [];
    for (const event of finished) {
      if (event.payload.stage !== stage) continue;
      if (event.payload.status !== "failed") break;
      const detail = event.payload.detail as { error?: unknown } | undefined;
      const error = typeof detail?.error === "string" ? detail.error.trim() : typeof event.payload.error === "string" ? event.payload.error.trim() : "";
      if (!error) break;
      errors.push(error);
      if (errors.length === STUCK_REPEATS) break;
    }
    if (errors.length < STUCK_REPEATS || new Set(errors).size !== 1) return null;
    return `stuck: ${stage} failed the same way ${STUCK_REPEATS} times: ${errors[0]}`;
  }

  /** The findings the latest verifying, ci_watch or failed implementing run stored on its
   *  `stage.finished` event. */
  private async latestVerifyingFindings(id: string): Promise<Finding[]> {
    const finished = await this.store.findFinishedEvents(id);
    // Whichever failed last is what the implementer is being re-run for: a red gate, or its
    // own previous attempt (e.g. it changed a locked test file and the commit was undone).
    const latest = finished.find(
      (event) =>
        event.payload.stage === "verifying" ||
        event.payload.stage === "ci_watch" ||
        // A card sent back from the browser run is handed that run's own findings, not the last Verify pass's.
        (event.payload.stage === "e2e" && event.payload.status === "failed") ||
        (event.payload.stage === "implementing" && event.payload.status === "failed"),
    );
    // The pack runner reports findings at the result's top level; a stub or an older event
    // may carry them inside detail.
    const detail = latest?.payload.detail as { findings?: unknown } | undefined;
    const findings = latest?.payload.findings ?? detail?.findings;
    return Array.isArray(findings) ? (findings as Finding[]) : [];
  }

  /** The decided reason of a Build escalation, or null when this move is not one. The move is previewed through the pure `transition` so that
   *  an escalation the machine makes (the run cap, the loop cap) is decided too. */
  private async decideBuildEscalation(id: string, result: StageResult, planned: PipelineEvent, why: { secondScopeRed: boolean; stuck: string | null; loopGuard: LoopStop | null }): Promise<{ decision: DecidedEscalation; reasonText: string } | null> {
    if (planned.type !== "stage_done" || result.rateLimited) return null;
    const task = await this.get(id);
    if (task.route !== "feature") return null;
    let preview: Step | null = null;
    try {
      preview = transition(task, planned);
    } catch {
      return null;
    }
    if (planned.outcome !== "escalated" && preview.state !== "escalated") return null;
    const detail = result.detail ?? {};
    const text = (value: unknown): string => (typeof value === "string" ? value : "");
    const reasonText = text(planned.reason) || preview.reason || "Build escalated";
    const budget = objectOf(detail.budget);
    const last = (await this.store.findFinishedEvents(id)).find((e) => e.payload.stage === "implementing");
    const lastDetail = objectOf(last?.payload.detail);
    const agentReason = EscalationReason.safeParse(detail.escalation);
    const limits = (await this.policyFor(task.repoPath)).factory.build;
    const decision = await withTask(id, async () => decideEscalation({
      stage: "implementing",
      summary: text(detail.summary) || reasonText,
      agent: { ...(agentReason.success ? { reason: agentReason.data } : {}), text: text(detail.reason) },
      output: text(detail.error) || text(detail.output) || text(lastDetail?.error) || text(lastDetail?.output),
      facts: {
        ...(why.secondScopeRed ? { scopeTwice: true } : {}),
        ...(detail.envBroken === true ? { envBroken: true } : {}),
        ...(detail.headMoved === true ? { headMoved: true } : {}),
        ...(why.loopGuard ? { loopGuard: why.loopGuard } : {}),
        ...(budget ? { budget: { spent: String(budget.spent), numbers: `${String(budget.iterations)} of ${limits.max_iterations} iterations, ${budget.tokens === null ? "tokens not counted" : `${String(budget.tokens)} of ${limits.max_tokens} tokens`}, ${String(budget.minutes)} of ${limits.max_minutes} minutes`, consecutiveReds: Number(budget.consecutiveReds ?? 0) } } : {}),
        notes: [...(why.stuck ? ["the stuck detector stopped the same failure repeating"] : []), ...(planned.outcome !== "escalated" ? [`the machine escalated: ${preview.reason ?? "a cap was reached"}`] : [])],
      },
      decide: this.escalationDecide.decide,
      repoPath: task.repoPath,
      overrides: (await this.policyFor(task.repoPath)).decisions,
    }));
    return { decision, reasonText };
  }

  /** How many implementing runs of the card ended in a scope red (a blocker the scope check found). */
  private async scopeReds(id: string): Promise<number> {
    return (await this.store.findFinishedEvents(id)).filter((e) => e.payload.stage === "implementing" && objectOf(e.payload.detail)?.scopeRed === true).length;
  }

  /** The commit the card's first implementing run started from, from the machine's own `stage_runs` rows (the host read it before the container ran); undefined before any run has one. */
  private async firstInputCommitOf(id: string): Promise<string | undefined> {
    const runs = (await this.stageRuns(id)).filter((r) => r.stage === "implementing" && (r.baseCommit ?? r.inputCommit) && /^[0-9a-f]{7,64}$/.test((r.baseCommit ?? r.inputCommit)!)).sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
    // The run's base is the commit its first container started from; `inputCommit` alone would be the tests commit once the implementer began on it.
    return runs[0] ? (runs[0].baseCommit ?? runs[0].inputCommit ?? undefined) : undefined;
  }

  /** The sha of the tests commit the machine itself made, from the newest implementing finish row that kept one (a sha, nothing else); undefined when there is none. */
  /** Whether a plan was approved after the implementing run that made the tests commit: the first finish row that recorded a tests commit, then
   *  any plan approval after it in the stream. */
  private async planChangedSinceTestsOf(id: string): Promise<boolean> {
    const events = await this.events(id);
    const made = events.findIndex((e) => e.kind === "stage.finished" && e.payload.stage === "implementing" && typeof objectOf(objectOf(e.payload.detail)?.testsStep)?.commit === "string" && objectOf(objectOf(e.payload.detail)?.testsStep)?.resumed !== true);
    if (made === -1) return false;
    return events.slice(made + 1).some((e) => e.kind === "transition" && e.payload.from === "awaiting_approval" && e.payload.event === "approved");
  }

  /** The locked test files a person approved changing: those the implementer's last test-change request names, once a plan was approved after it. */
  private async unlockedTestsOf(id: string): Promise<string[]> {
    const events = await this.events(id);
    // Event ids are bigints as strings: order by position in the stream, never by comparing the ids as text.
    const at = events.findLastIndex((e) => e.kind === "transition" && e.payload.to === "test_design" && e.payload.outcome === "test_change");
    if (at === -1) return [];
    const approvedAfter = events.slice(at + 1).some((e) => e.kind === "transition" && e.payload.from === "awaiting_approval" && e.payload.event === "approved");
    if (!approvedAfter) return [];
    const finished = (await this.store.findFinishedEvents(id)).find((e) => e.payload.stage === "implementing" && typeof objectOf(e.payload.detail)?.request === "string");
    return testPathsIn(String(objectOf(finished?.payload.detail)?.request ?? ""));
  }

  /** The scenarios the tests step recorded as already holding, from the newest implementing finish row that kept a tests commit. */
  private async testsHoldsTodayOf(id: string): Promise<string[]> {
    for (const finished of await this.store.findFinishedEvents(id)) {
      if (finished.payload.stage !== "implementing") continue;
      const step = objectOf(objectOf(finished.payload.detail)?.testsStep);
      if (typeof step?.commit !== "string") continue;
      const held = Array.isArray(step.holdsToday) ? step.holdsToday : [];
      return held.map((h) => objectOf(h)?.scenario).filter((s): s is string => typeof s === "string");
    }
    return [];
  }

  private async testsCommitOf(id: string): Promise<string | undefined> {
    for (const finished of await this.store.findFinishedEvents(id)) {
      if (finished.payload.stage !== "implementing") continue;
      const commit = objectOf(objectOf(finished.payload.detail)?.testsStep)?.commit;
      if (typeof commit === "string" && /^[0-9a-f]{7,64}$/.test(commit)) return commit;
    }
    return undefined;
  }

  /** Build's budget now, counted from the last fresh budget: whether it is spent and the minutes left. Read between the fix runs of a failed sweep. */
  async buildBudgetState(id: string): Promise<{ spent: boolean; minutesLeft: number }> {
    const task = await this.get(id);
    const { runs, events } = await this.budgetRows(id);
    const budget = buildBudget(runs, events, (await this.policyFor(task.repoPath)).factory.build);
    return { spent: budget.spent !== null, minutesLeft: budget.minutesLeft };
  }

  /** The minutes of Build's budget the card has left. */
  private async buildMinutesLeft(id: string, repoPath: string | null): Promise<number> {
    const limits = (await this.policyFor(repoPath)).factory.build;
    const { runs, events } = await this.budgetRows(id);
    return buildBudget(runs, events, limits).minutesLeft;
  }

  /** The rows Build's budget counts: all of them, or only those after the last `build.budget_reset` (the stronger model's one run starts a fresh budget, counted from its own start). */
  private async budgetRows(id: string): Promise<{ runs: StageRunRow[]; events: EventRow[] }> {
    const [runs, events] = await Promise.all([this.stageRuns(id), this.events(id)]);
    return budgetRowsOf(runs, events);
  }

  /** The result of a Build whose budget is spent (a person decides; no run is made), or null while there is budget. Logs the numbers as a `build.budget` row. */
  private async spentBuildBudget(id: string): Promise<StageResult | null> {
    const task = await this.get(id);
    if (task.route !== "feature") return null;
    const limits = (await this.policyFor(task.repoPath)).factory.build;
    const { runs, events } = await this.budgetRows(id);
    const budget = buildBudget(runs, events, limits);
    if (!budget.spent) return null;
    const numbers = { iterations: budget.iterations, tokens: budget.tokens, minutes: budget.minutes, consecutiveReds: budget.consecutiveReds, limits };
    await this.log(id, "build.budget", { spent: budget.spent, ...numbers });
    const said = { iterations: `${budget.iterations} of ${limits.max_iterations} iterations`, tokens: `${budget.tokens} of ${limits.max_tokens} tokens`, minutes: `${budget.minutes} of ${limits.max_minutes} minutes` }[budget.spent];
    return { outcome: "escalated", detail: { reason: `Build's budget is spent: ${said} (${budget.spent}); ${budget.tokensCounted ? "" : "tokens not counted; "}a person decides`, budget: { spent: budget.spent, ...numbers } } };
  }

  /** When the plan stage runs because a plan was found wrong (the last move into it was a `plan_wrong`): who raised it, why, and what the raising
   *  stage's last run said, flattened and capped (`replanOf`). Null for any other run of the plan stage. */
  private async replanEvidence(id: string): Promise<ReturnType<typeof replanOf> | null> {
    const entry = (await this.events(id)).findLast((e) => e.kind === "transition" && e.payload.to === "test_design");
    // A test change the implementer asked for is evidence too: the planner and the person at the plan gate read the request.
    if (entry && entry.payload.outcome === "test_change") {
      const finished = (await this.store.findFinishedEvents(id)).find((e) => e.payload.stage === "implementing");
      const request = objectOf(finished?.payload.detail)?.request;
      return replanOf({ raisedBy: "implementing (a test change)", reason: typeof request === "string" ? `The implementer asks to change a locked test: ${request}` : "the implementer asks to change a locked test", finished: null });
    }
    if (!entry || entry.payload.escalation !== "plan_wrong" || typeof entry.payload.from !== "string") return null;
    const from = entry.payload.from;
    const finished = (await this.store.findFinishedEvents(id)).find((e) => e.payload.stage === from);
    const detail = finished?.payload.detail;
    const missing = objectOf(detail)?.entryContract;
    return replanOf({
      raisedBy: Array.isArray(missing) ? "entry_contract" : from,
      reason: typeof entry.payload.reason === "string" ? entry.payload.reason : "the plan was found wrong",
      finished: finished ? { detail: objectOf(detail) ?? null, findings: finished.payload.findings ?? objectOf(detail)?.findings } : null,
    });
  }

  private async runStage(id: string, stage: TaskState, signal: AbortSignal, resume?: Resume, fallback?: { engine: EngineId; reason: string }): Promise<StageResult> {
    // Re-attaching after a restart: the run row and its container already exist.
    const attempt = resume?.attempt ?? (await this.store.countStageRunAttempts(id, stage)) + 1;
    const runId = resume?.runId ?? (await this.store.insertStageRun({ taskId: id, stage, attempt }));
    if (!resume) await this.log(id, "stage.started", { stage, attempt }, runId);
    // A stage starting is the card resuming: whatever an earlier escalation kept besides the clone goes.
    if (!resume) await this.releaseKept?.(id).catch((error: unknown) => console.error(`could not release the kept sandbox of ${id}`, error));
    if (fallback) await this.log(id, "stage.engine", { stage, pack: packForState(stage), engine: fallback.engine, reason: fallback.reason }, runId);

    const t0 = Date.now();
    const span: RunSpan = this.telemetry.run({ kind: "stage", pack: packForState(stage), engine: fallback?.engine ?? resume?.engine ?? null, sessionId: id, taskId: id, stage, attempt });
    if (fallback) span.event("engine", { engine: fallback.engine, reason: fallback.reason });
    let repo: string | null = null;

    let result: StageResult;
    let error: string | undefined;
    /** The engine the run is on, as the runner says when it starts: what its cost counts against. */
    let ranOn: EngineId | null = fallback?.engine ?? resume?.engine ?? null;
    try {
      const [task, approvals, priorFindings, replan] = await Promise.all([
        this.get(id),
        this.approvals(id),
        stage === "implementing" ? this.latestVerifyingFindings(id) : Promise.resolve([]),
        stage === "test_design" ? this.replanEvidence(id) : Promise.resolve(null),
      ]);
      repo = task.repoPath;
      const budgetMinutes = stage === "implementing" && task.route === "feature" ? await this.buildMinutesLeft(id, task.repoPath) : undefined;
      const testsCommit = (stage === "implementing" || stage === "verifying") && task.route === "feature" ? await this.testsCommitOf(id) : undefined;
      const testsHoldsToday = testsCommit && stage === "implementing" ? await this.testsHoldsTodayOf(id) : [];
      const planChangedSinceTests = testsCommit && stage === "implementing" ? await this.planChangedSinceTestsOf(id) : false;
      const unlockedTests = stage === "implementing" ? await this.unlockedTestsOf(id) : [];
      const firstInputCommit = stage === "implementing" && task.route === "feature" ? await this.firstInputCommitOf(id) : undefined;
      // The entry contract of Build: the feature route builds only from what Plan hands over; what is missing goes back to the planner (once per card), then to a person.
      const entry = stage === "implementing" && task.route === "feature" && !resume ? buildEntryOf(approvals, task.record) : null;
      if (entry && !entry.ok) {
        await this.log(id, "build.entry_contract", { ok: false, missing: entry.missing, readAs: entry.readAs }, runId);
        const reason = `Build cannot start: missing ${entry.missing.join("; ")}`;
        result = { outcome: "escalated", detail: { escalation: "plan_wrong", reason, entryContract: entry.missing } };
      } else result = await this.runnerFor(stage)({
        task,
        stage,
        attempt,
        runId,
        approvals,
        priorFindings,
        ...(stage === "delivering" ? { prFacts: await this.prFacts(id) } : {}),
        ...((stage === "delivering" || stage === "ci_watch") && task.route === "feature" ? { recordedPrs: await this.recordedPrs(id) } : {}),
        ...(replan ? { replan } : {}),
        ...(budgetMinutes !== undefined ? { budgetMinutes } : {}),
        ...(testsCommit ? { testsCommit } : {}),
        ...(testsHoldsToday.length ? { testsHoldsToday } : {}),
        ...(planChangedSinceTests ? { planChangedSinceTests } : {}),
        ...(unlockedTests.length ? { unlockedTests } : {}),
        ...(firstInputCommit ? { firstInputCommit } : {}),
        signal,
        ...(resume ? { resume: { container: resume.container, inputCommit: resume.inputCommit, engine: resume.engine } } : {}),
        ...(fallback ? { engine: fallback.engine } : {}),
        started: (facts) => {
          ranOn = facts.engine ?? ranOn;
          span.event("started", { container: facts.container, engine: facts.engine ?? null });
          return this.store.markStageRunStarted(runId, { containerId: facts.container, inputCommit: facts.inputCommit, ...(facts.engine ? { engine: facts.engine } : {}) });
        },
        note: (text) => this.log(id, "stage.note", { stage, note: text }, runId),
        emit: async (kind, payload) => {
          // Checked at run time too: the type is no guard against a caller that casts.
          if (!(EMITTABLE as readonly string[]).includes(kind)) return console.warn(`stage ${stage} tried to log "${String(kind).slice(0, 60)}": not an event a stage may emit; dropped`);
          await this.log(id, kind, payload, runId);
        },
        traceEnv: span.childEnv(),
      });
    } catch (thrown) {
      error = thrown instanceof Error ? thrown.message : String(thrown);
      // A service that never became ready is the environment's fault, a fact the escalation reason does not ask a model about.
      result = { outcome: "fail", ...(thrown instanceof Error && thrown.name === "ServiceNotReadyError" ? { detail: { envBroken: true } } : {}) };
    }

    const status = signal.aborted
      ? "aborted"
      : result.rateLimited
        ? "paused"
        : result.outcome === "fail" || result.outcome === "escalated"
          ? "failed"
          : "passed";
    const outcome = result.rateLimited ? "rate_limited" : result.outcome;
    await this.store.updateStageRun(runId, {
      status,
      outcome,
      ended: true,
      // The container and input commit were stored when the stage started (`started`); a
      // result that names them again wins, one that does not leaves them be.
      ...(result.run?.containerId ? { containerId: result.run.containerId } : {}),
      ...(result.run?.inputCommit ? { inputCommit: result.run.inputCommit } : {}),
      transcriptPath: result.run?.transcriptPath ?? null,
      outputCommit: result.run?.outputCommit ?? null,
      ...(result.usage ? { turns: result.usage.turns, costUsd: result.usage.costUsd?.toString() ?? null } : {}),
      ...(stage === "verifying" ? { cases: casesOf(result.detail) } : {}),
      ...runFacts(result.run?.info),
    });
    if (result.rateLimited) span.event("rate_limited", { resetsAt: result.detail?.resetsAt ?? null });
    if (result.outcome === "escalated") span.event("escalated", { reason: result.detail?.reason ?? null });
    for (const item of result.events ?? []) span.event(item.kind.replace(/^stage\./, ""), item.payload);
    await span.end({
      outcome,
      status,
      engine: ranOn,
      error: error ?? (typeof result.detail?.error === "string" ? result.detail.error : null),
      summary: typeof result.detail?.summary === "string" ? result.detail.summary : null,
      repo,
      model: result.run?.info?.modelId ?? null,
      turns: result.usage?.turns ?? null,
      costUsd: result.usage?.costUsd ?? null,
      durationMs: Date.now() - t0,
      info: result.run?.info ?? null,
      transcriptPath: result.run?.transcriptPath ?? null,
    });
    if (result.usage?.costUsd) {
      await this.raiseAlerts(id);
      if (ranOn && this.engineBudgets) await this.engineBudgets.afterRun(ranOn, { taskId: id, repo: (await this.store.getTask(id))?.repoPath ?? null });
    }
    for (const artifact of result.artifacts ?? []) {
      await this.store.insertArtifact({ taskId: id, stageRunId: runId, ...artifact });
    }
    for (const item of result.events ?? []) {
      const kind = item.kind.startsWith("stage.") ? item.kind : `stage.${item.kind}`;
      await this.log(id, kind, { ...item.payload, at: item.at }, runId);
    }
    if (result.workspace) {
      await this.store.updateTask(id, { branch: result.workspace.branch, worktreePath: result.workspace.worktreePath });
    }
    await this.recordTriad(id, stage, status, result);
    const report = status === "passed" ? await this.reportFor(id, stage, { stage, attempt, status, outcome, ...(result.usage?.tokens ? { tokens: result.usage.tokens } : {}), ...(result.detail ? { detail: result.detail } : {}) }).catch(() => null) : null;
    await this.log(
      id,
      "stage.finished",
      {
        stage,
        attempt,
        status,
        outcome,
        ...(error ? { error } : {}),
        ...(result.usage?.tokens ? { tokens: result.usage.tokens } : {}),
        ...(result.detail || report ? { detail: { ...result.detail, ...(report ? { report } : {}) } } : {}),
        // What the next implementing attempt is handed as prior findings (see latestVerifyingFindings).
        ...(result.findings?.length ? { findings: result.findings } : {}),
      },
      runId,
    );
    // Facts the run knew that had no row of their own: logged once, beside the finish, under the diagram's name.
    for (const fact of stageFactRows(stage, status, result)) await this.log(id, fact.kind, fact.payload, runId);
    return result;
  }

  /** The v2.2 report a passing finish carries: Build's on `implementing`, Verify's on `ci_watch` (the last step of verify). */
  private async reportFor(id: string, stage: TaskState, finishing: Record<string, unknown>): Promise<BuildReport | VerifyReport | null> {
    if (stage !== "implementing" && stage !== "ci_watch") return null;
    const [task, runs, events] = await Promise.all([this.get(id), this.store.listStageRuns(id), this.store.listEvents(id)]);
    // This run's finish is not logged yet: it is the newest row.
    const current: EventRow = { id: "0", taskId: id, stageRunId: null, kind: "stage.finished", payload: finishing, at: new Date() };
    return stage === "implementing" ? buildReportOf(task, runs, [...events, current], (await this.policyFor(task.repoPath)).factory.build) : verifyReportOf(task, runs, [...events, current]);
  }

  /** Build's progress while it runs (for the board's detail): null for a card that has not begun to build. Counts from the last fresh budget. */
  async buildProgress(id: string): Promise<BuildProgress | null> {
    const task = await this.get(id);
    if (task.route !== "feature") return null;
    const [runs, events] = await Promise.all([this.stageRuns(id), this.events(id)]);
    return buildProgressOf(runs, events, (await this.policyFor(task.repoPath)).factory.build);
  }

  /** The task's Build and Verify Reports, each null until its stage has passed; `GET /tasks/:id` shows them. */
  async reports(id: string): Promise<TaskReports> {
    const [task, runs, events] = await Promise.all([this.get(id), this.store.listStageRuns(id), this.store.listEvents(id)]);
    const build = buildReportOf(task, runs, events, (await this.policyFor(task.repoPath)).factory.build);
    const ciPassed = runs.some((r) => r.stage === "ci_watch" && r.status === "passed");
    return { build, verify: ciPassed ? verifyReportOf(task, runs, events) : null };
  }

  /** A repository image's event as a row on the card that needed it: started, built, refused or failed (text already flattened and capped). */
  async recordImageEvent(taskId: string, event: { kind: string } & Record<string, unknown>): Promise<void> {
    const { kind, taskId: _t, ...payload } = event;
    await this.log(taskId, kind, payload);
  }

  private async log(
    taskId: string,
    kind: string,
    payload: Record<string, unknown>,
    stageRunId: string | null = null,
  ): Promise<void> {
    this.onEvent(await this.store.recordEvent({ taskId, kind, payload, stageRunId }));
  }
}

/** Whether an escalation's gate is Build's spent budget: the pipeline's own check (`budget.spent`) or the tests step's (`budgetSpent`). */
function budgetWasSpent(requested: Record<string, unknown>): boolean {
  const budget = requested.budget as { spent?: unknown } | undefined;
  return requested.budgetSpent === true || (typeof budget?.spent === "string" && budget.spent !== "");
}

/** The test files a test-change request names (repo-relative paths that look like tests), each once. */
export function testPathsIn(request: string): string[] {
  // A path starts where no path character is before it: `/abs/y.test.ts` is not `abs/y.test.ts`, and `../x` is refused below.
  const paths = request.match(/(?<![A-Za-z0-9_@.\/-])[A-Za-z0-9_@.\-]+(?:\/[A-Za-z0-9_@.\-]+)+\.[A-Za-z0-9]+/g) ?? [];
  return [...new Set(paths.filter((p) => !p.startsWith("/") && !p.includes("..") && looksLikeTestPath(p)))];
}

