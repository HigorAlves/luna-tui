// The machine's HTTP API: commands for the board, and a Server-Sent Events stream of
// updates. Shapes are defined in @hardness/contracts.
import type { ApiError, PrAction, PullRequest, TaskDiff, TaskSla, ShipView, RepoHealth } from "@hardness/contracts";
import type { MachinePolicy } from "@hardness/contracts";
import type { EconomyConfig } from "@hardness/contracts";
import type { Hono } from "hono";
import type { Economy } from "../../application/economy.ts";
import { type Backlog, BacklogItemNotFoundError, NotSchedulableError } from "../../application/backlog.ts";
import type { ChangeEvidence } from "../../application/change-evidence.ts";
import type { AccessReview } from "../../application/access-review.ts";
import type { StatusReport } from "../../application/status-report.ts";
import type { IncidentJob } from "../../application/incidents.ts";
import type { Questionnaires } from "../../application/questionnaires.ts";
import type { Vulns } from "../../application/vulns.ts";
import type { ReleaseNotes } from "../../application/release-notes.ts";
import { type ComplianceDrafts, type CompliancePublisher, DraftNeedsRepoError, DraftNotFoundError, DraftRefusedError, DraftStatusError, StaleDraftError } from "../../application/compliance-drafts.ts";
import { type TicketMachine, TicketNotFound, TicketRefusal } from "../../application/ticket-machine.ts";
import type { DataSource } from "typeorm";
import { ZodError, z } from "zod";
import { DEFAULT_PORT } from "../../config.ts";
import { PgTaskStore } from "../persistence/task-store.ts";
import type { TaskRow } from "../../domain/task.ts";
import { EngineBudgetWatch } from "../../application/engine-gates.ts";
import { type Credentials, machineCredentials } from "../credentials/index.ts";
import { TransitionError } from "../../domain/transition.ts";
import { type RepoSignals, noRepoSignals } from "../../application/repo-signals.ts";
import { type ConfigProofs, ConfigProofError } from "../../application/config-proofs.ts";
import type { Watcher } from "../../application/ports.ts";
import { ApproverRequiredError, ConfigRebuildError, CoverageGapsError, IdempotencyConflictError, InvalidEscalationReasonError, NoEscalationToCorrectError, MergeError, DedupAnswerError, UnknownRepositoryError, NoCasesToEditError, NoContextGateError, NoPlanToEditError, NoQuestionsToPostError, OutsideApproverRequiredError, PlanApprovedError, type Pipeline, QuestionsCarrySecretError, RecordNotEditableError, RejectNotAllowedError, RepoPathLockedError, SplitAutoApprovalError, SplitChangedError, SplitNotValidError, SameApproverError, SourceImmutableError, StageStartedError, TaskBusyError, TaskNotFoundError, FindingNotFoundError, NoEvidenceError, NotReleaseOwnerError, WorktreeUnpushedError } from "../../application/pipeline.ts";
import { NoFileError, NoWorktreeError } from "../git/diff.ts";
import { ForkError, NoCheckoutError, OwnPrError, PrBusyError } from "../../application/pr-tasks.ts";
import { CloneError, NoPullError, NotReadyError, type PullsPort } from "../../application/pulls.ts";
import { type McpApi, mountMcpCallback, mountMcpRoutes } from "./mcp.ts";
import { mountDesignRoutes } from "./design.ts";
import type { PolicyStore } from "../../application/policy.ts";
import { AlreadyTaskError, BadRelationError, BuiltinWatchError, NoItemError, NoWatchError, SlackRefusedError, type SlackInboxPort } from "../../application/slack-inbox.ts";
import { NoSlackTokenError } from "../../application/slack.ts";
import { NoJiraTokenError } from "../../application/jira.ts";
import { AlreadyLinkedElsewhereError, AlreadyLinkedError, HasWorktreeError, type JiraTasksPort, NoIssueError, NoProjectError, NotchTaskError } from "../../application/jira-tasks.ts";
import type { StubStages } from "../../application/stages/stubs.ts";
import { type ApiAccess, guard } from "./access.ts";
import { EngineNotAllowedError, NotOnDemandError, type PackRunsPort, QueueFullError, RunAbortedError, RunEngineBudgetError, RunEngineDisabledError, RunFailedError, RunNoCredentialError, RunOverBudgetError, RunRateLimitedError } from "../../application/pack-runs.ts";
import type { Bus } from "./bus.ts";
import { toTask } from "./serialize.ts";
import { createOpenApiRouter } from "./openapi/router.ts";
import { BadRequest, CLIENT_CLOSED, body, fail, type RouteDeps } from "./routes/kit.ts";
import { machineRoutes } from "./routes/machine.routes.ts";
import { eventsRoutes } from "./routes/events.routes.ts";
import { reposRoutes } from "./routes/repos.routes.ts";
import { economyRoutes } from "./routes/economy.routes.ts";
import { tasksRoutes } from "./routes/tasks.routes.ts";
import { backlogRoutes } from "./routes/backlog.routes.ts";
import { complianceRoutes } from "./routes/compliance.routes.ts";
import { ticketsRoutes } from "./routes/tickets.routes.ts";
import { githubRoutes } from "./routes/github.routes.ts";
import { slackRoutes } from "./routes/slack.routes.ts";
import { jiraRoutes } from "./routes/jira.routes.ts";

export type { ApiAccess } from "./access.ts";

const DEFAULT_ACCESS: ApiAccess = { host: "127.0.0.1", port: DEFAULT_PORT, token: null };

export interface AppDeps {
  /** Each repository's image and graph health for `GET /repos`; absent, the list is empty. */
  repoHealth?: () => Promise<RepoHealth[]>;
  /** Approves a base for a repository (refused unless it is the one in the repository's luna.yaml on the user's checkout); absent, `POST /repos/base/approve` is absent. */
  approveBase?: (repo: string, base: string) => Promise<{ ok: true } | { ok: false; reason: string }>;
  /** The token economy (RFC 0007) with the repositories the machine knows and each one's `economy` policy; absent (`MACHINE_ECONOMY=off`), the `/economy` routes and the metrics' `economy` are absent. */
  economy?: { port: Economy; knownRepos: () => Promise<string[]>; configOf: (repo: string) => Promise<EconomyConfig> };
  db: DataSource;
  pipeline: Pipeline;
  bus: Bus;
  /** The shared backlog; without it the `/backlog` routes are absent. */
  backlog?: Backlog;
  /** The Ticket Machine; without it the `/tickets` routes are absent. */
  tickets?: TicketMachine;
  /** The manager's drafts (RFC 0008): the store, the publisher an approve goes through, the monthly evidence job, the quarterly access review, the incidents and the `owner/name` of every repo the machine knows. Without it the `/compliance` routes answer 503. */
  compliance?: { drafts: ComplianceDrafts; publisher: CompliancePublisher; evidence: Pick<ChangeEvidence, "buildMonth">; repos: () => Promise<string[]>; access?: Pick<AccessReview, "orgs" | "buildQuarter">; incidents: Pick<IncidentJob, "list">; vulns?: Pick<Vulns, "list">; releaseNotes?: Pick<ReleaseNotes, "draft">; questionnaires?: Pick<Questionnaires, "rerun">; status?: Pick<StatusReport, "build"> };
  /** Closes a task's herdr watch tab when it is deleted; closing it on `closed` is main.ts's job. */
  watcher?: Watcher;
  /** Enables `POST /dev/stubs` when the stub stages are in use. */
  stubs?: StubStages;
  /** The PR inbox's poller; without it the `/github/*` routes are absent. */
  pulls?: PullsPort;
  /** Turns an action on a PR into a running PR task; without it `POST .../actions` is absent. */
  prTasks?: { dispatch(pr: PullRequest, action: PrAction): Promise<TaskRow> };
  /** The task branch's diff from its worktree; without it `GET /tasks/:id/diff` is absent. */
  taskDiff?: (worktreePath: string, repoPath: string | null, file?: string) => Promise<TaskDiff>;
  /** The Slack inbox; without it the `/slack/*` routes are absent. */
  slack?: SlackInboxPort;
  /** The MCP servers' status and login (RFC 0013); without it the `/mcp` routes are absent. */
  mcp?: McpApi;
  /** The design routes (RFC 0013): each repo's policy (its `design` section and QA targets), and whether the QA image is built. Without `policies` no repo has a design section or QA target. */
  policies?: Pick<PolicyStore, "for">;
  qaImage?: boolean;
  /** Jira by hand (link, unlink, create, search, status); without it the `/jira/*` and `/tasks/:id/jira*` routes are absent. */
  jira?: JiraTasksPort;
  /** The ticket's SLA clocks, computed when a task is answered or published; without it every task shows `sla: null`. */
  sla?: (task: TaskRow) => Promise<TaskSla | null>;
  /** The watched PR's checklist and clocks for `GET /tasks/:id`; without it `ship` is null. */
  shipView?: (taskId: string) => Promise<ShipView | null>;
  /** The same for a whole list at once (`GET /tasks`); falls back to `sla` per task. */
  slaAll?: (tasks: TaskRow[]) => Promise<Map<string, TaskSla | null>>;
  /** Whether this machine has each engine's credential, for `GET /engines`; defaults to the machine's own. */
  credentials?: Pick<Credentials, "check">;
  /** The monthly caps per engine, for `GET /engines`' spend and budget; defaults to no caps over the database's spend. */
  engineBudgets?: Pick<EngineBudgetWatch, "standings">;
  /** Who may call (see access.ts); defaults to a loopback machine on the default port with no token. */
  access?: ApiAccess;
  /** Packs on demand (`POST /runs`); without it (MACHINE_AGENTS=off) the route answers 503 `agents_off`. */
  runs?: PackRunsPort;
  /** Proofs of a repository's own luna.yaml for the setup skill; without it (no sandbox) `POST /repos/config/prove` answers 503. */
  configProofs?: ConfigProofs;
  /** The repo's own run signals for `POST /repos/proposals`; defaults to none, so no proposal is made until an adapter backs it. */
  repoSignals?: RepoSignals;
  /** Every checkout the machine knows, for `POST /repos/proposals`; without it no repo is known and the route answers 404 `unknown_repo`. */
  knownRepos?: () => Promise<string[]>;
  /** The repos `POST /ticket-chat` may let the planner read: the repo map, the links made through `POST /github/clone` and the GitHub checkouts, never a task's `repoPath`. Anyone who can call the API can add a link, so this is not a privilege boundary. Without it the route answers 404 `unknown_repo` for every repo. */
  chatRepos?: () => Promise<string[]>;
  /** What time it is for `POST /repos/proposals` (its signal, decline and evidence windows); tests inject one. Defaults to the system clock. */
  clock?: () => Date;
  /** What keeps the machine from doing its job (`readinessProblems`), read on each `GET /health`; absent, `/health` is always ok. */
  problems?: () => Promise<string[]> | string[];
  /** The machine's sandbox policy in force (`sandbox.yaml`), shown on `GET /health`; absent, not shown. */
  sandboxPolicy?: MachinePolicy;
}

export function createApp({ repoHealth, approveBase, economy, db, pipeline, bus, backlog, tickets, compliance, watcher, stubs, pulls, prTasks, taskDiff, slack, jira, sla, slaAll, shipView, credentials = machineCredentials(), engineBudgets, access = DEFAULT_ACCESS, runs, configProofs, repoSignals = noRepoSignals(), knownRepos = async () => [], chatRepos = async () => [], clock = () => new Date(), problems: problemsOf, sandboxPolicy, mcp, policies, qaImage = false }: AppDeps): Hono {
  const app = createOpenApiRouter();
  engineBudgets ??= new EngineBudgetWatch({ budgets: {}, spend: new PgTaskStore(db), onAlert: () => {} });
  // The OAuth callback is the one route a browser reaches with no token; it takes only a login this machine started.
  if (mcp) mountMcpCallback(app, mcp);
  app.use(guard(access));
  if (mcp) mountMcpRoutes(app, mcp);
  /** A task row as the board reads it, clocks included. */
  const serialize = async (row: TaskRow, usage: { spentUsd: number; workedMs: number } | null = null) =>
    toTask(row, usage, sla ? await sla(row) : null, await pipeline.glance(row.id));

  app.onError((error, c) => {
    if (error instanceof TaskNotFoundError) return fail(c, 404, "not_found", error.message);
    if (error instanceof TransitionError) return fail(c, 409, "invalid_transition", error.message);
    if (error instanceof ConfigRebuildError) return fail(c, 409, "config_changed", error.message);
    if (error instanceof TaskBusyError) return fail(c, 409, "task_busy", error.message);
    if (error instanceof WorktreeUnpushedError) return fail(c, 409, "unpushed_commits", error.message);
    if (error instanceof IdempotencyConflictError) return c.json<ApiError>({ error: "idempotency_conflict", message: error.message, taskId: error.taskId }, 409);
    if (error instanceof StaleDraftError) return fail(c, 409, "stale_draft", error.message);
    if (error instanceof DraftStatusError) return fail(c, 409, "draft_not_waiting", error.message);
    if (error instanceof DraftNotFoundError) return fail(c, 404, "not_found", error.message);
    if (error instanceof DraftRefusedError) return fail(c, 422, "secret", error.message);
    if (error instanceof DraftNeedsRepoError) return fail(c, 422, "needs_repository", error.message);
    if (error instanceof TicketNotFound) return fail(c, 404, "not_found", error.message);
    if (error instanceof TicketRefusal) return fail(c, 409, "ticket_refused", error.message);
    if (error instanceof BacklogItemNotFoundError) return fail(c, 404, "not_found", error.message);
    if (error instanceof NotSchedulableError) return fail(c, 409, "not_schedulable", error.message, { blockedBy: error.blockedBy });
    if (error instanceof UnknownRepositoryError) return fail(c, 400, "unknown_repository", error.message);
    if (error instanceof DedupAnswerError) return fail(c, 400, "invalid_candidate", error.message);
    if (error instanceof MergeError) return fail(c, 409, "cannot_merge", error.message);
    if (error instanceof NoContextGateError) return fail(c, 409, "no_context_gate", error.message);
    if (error instanceof NoPlanToEditError) return fail(c, 409, "no_plan", error.message);
    if (error instanceof FindingNotFoundError) return fail(c, 404, "not_found", error.message);
    if (error instanceof NoEvidenceError) return fail(c, 409, "no_evidence", error.message);
    if (error instanceof NoQuestionsToPostError) return fail(c, 409, "no_questions", error.message);
    if (error instanceof QuestionsCarrySecretError) return fail(c, 409, "secret", error.message);
    if (error instanceof RecordNotEditableError) return fail(c, 409, "record_locked", error.message);
    if (error instanceof NoCasesToEditError) return fail(c, 409, "no_cases", error.message);
    if (error instanceof NoEscalationToCorrectError) return fail(c, 409, "no_escalation", error.message);
    if (error instanceof InvalidEscalationReasonError) return fail(c, 400, "invalid_reason", error.message);
    if (error instanceof ApproverRequiredError) return fail(c, 400, "approver_required", error.message);
    if (error instanceof SameApproverError) return fail(c, 409, "same_approver", error.message);
    if (error instanceof NotReleaseOwnerError) return fail(c, 409, "not_release_owner", error.message);
    if (error instanceof OutsideApproverRequiredError) return fail(c, 409, "outside_approver_required", error.message);
    if (error instanceof CoverageGapsError) return fail(c, 409, "coverage_gaps", error.message, { gaps: error.gaps });
    if (error instanceof PlanApprovedError) return fail(c, 409, "plan_approved", error.message);
    if (error instanceof RejectNotAllowedError) return fail(c, 409, "reject_not_allowed", error.message);
    if (error instanceof SplitChangedError) return fail(c, 409, "split_changed", error.message);
    if (error instanceof SplitAutoApprovalError) return fail(c, 409, "split_needs_a_person", error.message);
    if (error instanceof SplitNotValidError) return fail(c, 409, "split_not_valid", error.message);
    if (error instanceof StageStartedError) return fail(c, 409, "stage_started", error.message);
    if (error instanceof SourceImmutableError) return fail(c, 400, "source_immutable", error.message);
    if (error instanceof RepoPathLockedError) return fail(c, 409, "has_worktree", error.message);
    if (error instanceof NoWorktreeError) return fail(c, 404, "no_worktree", error.message);
    if (error instanceof NoFileError) return fail(c, 404, "no_file", error.message);
    if (error instanceof NotReadyError) return fail(c, 409, "not_ready", error.message);
    if (error instanceof NoPullError) return fail(c, 404, "no_pull", error.message);
    if (error instanceof PrBusyError) return fail(c, 409, "pr_busy", error.message);
    if (error instanceof NoCheckoutError) return fail(c, 409, "no_checkout", error.message);
    if (error instanceof ForkError) return fail(c, 409, "fork", error.message);
    if (error instanceof OwnPrError) return fail(c, 409, "own_pr", error.message);
    if (error instanceof CloneError) return fail(c, 400, "invalid_request", error.message);
    if (error instanceof SlackRefusedError) return fail(c, 409, "slack_refused", error.message);
    if (error instanceof BadRelationError) return fail(c, 400, "invalid_request", error.message);
    if (error instanceof NoItemError) return fail(c, 404, "no_item", error.message);
    if (error instanceof NoWatchError) return fail(c, 404, "no_watch", error.message);
    if (error instanceof NoSlackTokenError) return fail(c, 409, "no_token", error.message);
    if (error instanceof AlreadyTaskError) return fail(c, 409, "already_task", error.message);
    if (error instanceof BuiltinWatchError) return fail(c, 409, "builtin", error.message);
    if (error instanceof NoJiraTokenError) return fail(c, 409, "no_token", error.message);
    if (error instanceof NoIssueError) return fail(c, 404, "no_issue", error.message);
    if (error instanceof AlreadyLinkedElsewhereError) return fail(c, 409, "already_linked_elsewhere", error.message);
    if (error instanceof HasWorktreeError) return fail(c, 409, "has_worktree", error.message);
    if (error instanceof AlreadyLinkedError) return fail(c, 409, "already_linked", error.message);
    if (error instanceof NoProjectError) return fail(c, 409, "no_project", error.message);
    if (error instanceof NotchTaskError) return fail(c, 409, "notch_task", error.message);
    if (error instanceof NotOnDemandError) return fail(c, 400, "not_on_demand", error.message);
    if (error instanceof EngineNotAllowedError) return fail(c, 400, "engine_not_allowed", error.message);
    if (error instanceof RunNoCredentialError) return fail(c, 409, "no_credential", error.message);
    if (error instanceof RunEngineDisabledError) return fail(c, 409, "runtime_disabled", error.message);
    if (error instanceof RunEngineBudgetError) return fail(c, 409, "budget", error.message);
    if (error instanceof RunRateLimitedError) return fail(c, 429, "rate_limited", error.message, { resetsAt: error.resetsAt });
    if (error instanceof RunFailedError) return fail(c, 422, "run_failed", error.message);
    if (error instanceof QueueFullError) return fail(c, 429, "queue_full", error.message);
    if (error instanceof RunOverBudgetError) return fail(c, 429, "budget", error.message);
    if (error instanceof RunAbortedError) return fail(c, CLIENT_CLOSED, "client_closed", error.message);
    if (error instanceof ZodError) return fail(c, 400, "invalid_request", z.prettifyError(error));
    if (error instanceof BadRequest) return fail(c, 400, "invalid_request", error.message);
    if (error instanceof ConfigProofError) return fail(c, 400, "invalid_request", error.message);
    console.error(error);
    return fail(c, 500, "internal", error.message);
  });

  const deps: RouteDeps = { repoHealth, approveBase, economy, db, pipeline, bus, backlog, tickets, compliance, watcher, stubs, pulls, prTasks, taskDiff, slack, jira, sla, slaAll, shipView, credentials, engineBudgets, runs, configProofs, repoSignals, knownRepos, chatRepos, clock, problemsOf, sandboxPolicy, mcp, policies, qaImage, serialize };
  mountDesignRoutes(app, { runs, chatRepos, policies, qaImage }, { body, fail: (c, status, error, message) => fail(c, status, error, message) });
  app.route("/", machineRoutes(deps));
  app.route("/", eventsRoutes(deps));
  app.route("/", reposRoutes(deps));
  app.route("/", economyRoutes(deps));
  app.route("/", tasksRoutes(deps));
  app.route("/", backlogRoutes(deps));
  app.route("/", complianceRoutes(deps));
  app.route("/", ticketsRoutes(deps));
  app.route("/", githubRoutes(deps));
  app.route("/", slackRoutes(deps));
  app.route("/", jiraRoutes(deps));

  return app;
}
