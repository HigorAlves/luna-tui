// The machine's HTTP API: commands for the board, and a Server-Sent Events stream of
// updates. Shapes are defined in @hardness/contracts.
import {
  AnswersInput,
  type ApiError,
  CloneInput,
  ArchiveInput,
  DecisionInput,
  EngineId,
  type PrAction,
  PrActionInput,
  type PullRequest,
  EditCasesInput,
  EditPlanInput,
  EditStagesInput,
  JiraCreateInput,
  JiraLinkInput,
  METRICS_GROUP_BY,
  type MetricsGroupBy,
  type TaskDiff,
  type TaskSla,
  CARD_EVENT_NAMES,
  CardEventName,
  NewTaskInput,
  PACKS,
  PackId,
  RunInput,
  SetupRepoInput,
  SlackItemPatch,
  SlackReplyInput,
  SlackTaskInput,
  SlackWatchInput,
  SlackWatchPatch,
  type StreamMessage,
  StubPlanInput,
  TaskSource,
  TaskState,
  UpdateTaskInput,
} from "@hardness/contracts";
import { type Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { DataSource } from "typeorm";
import { ZodError, type ZodType, z } from "zod";

const SlotsInput = z.object({ max: z.number().int().min(1) });

import { DEFAULT_PORT } from "../../config.ts";
import { computeMetrics } from "../persistence/metrics-query.ts";
import { PgTaskStore } from "../persistence/task-store.ts";
import type { TaskRow } from "../../domain/task.ts";
import { packInfo } from "../../domain/packs.ts";
import { engineInfo } from "../../domain/engines.ts";
import { EngineBudgetWatch } from "../../application/engine-gates.ts";
import { type Credentials, machineCredentials } from "../credentials/index.ts";
import { TransitionError } from "../../domain/transition.ts";
import type { Watcher } from "../../application/ports.ts";
import { ApproverRequiredError, IdempotencyConflictError, NoCasesToEditError, NoPlanToEditError, type Pipeline, RepoPathLockedError, SameApproverError, SourceImmutableError, StageStartedError, TaskBusyError, TaskNotFoundError } from "../../application/pipeline.ts";
import { taskStagesProblem } from "../../domain/engine-choice.ts";
import { NoFileError, NoWorktreeError } from "../git/diff.ts";
import { ForkError, NoCheckoutError, OwnPrError, PrBusyError } from "../../application/pr-tasks.ts";
import { CloneError, NoPullError, NotReadyError, type PullsPort } from "../../application/pulls.ts";
import { AlreadyTaskError, BuiltinWatchError, NoItemError, NoWatchError, type SlackInboxPort } from "../../application/slack-inbox.ts";
import { NoSlackTokenError } from "../../application/slack.ts";
import { NoJiraTokenError } from "../../application/jira.ts";
import { AlreadyLinkedElsewhereError, AlreadyLinkedError, HasWorktreeError, type JiraTasksPort, NoIssueError, NoProjectError, NotchTaskError } from "../../application/jira-tasks.ts";
import type { StubStages } from "../../application/stages/stubs.ts";
import { type ApiAccess, guard } from "./access.ts";
import { EngineNotAllowedError, NotOnDemandError, type PackRunsPort, QueueFullError, RunAbortedError, RunEngineBudgetError, RunEngineDisabledError, RunFailedError, RunNoCredentialError, RunOverBudgetError, RunRateLimitedError } from "../../application/pack-runs.ts";
import type { Bus } from "./bus.ts";
import { InvalidSince, parseSince } from "./metrics.ts";
import { ReplayFeed } from "./replay.ts";
import { toApproval, toArtifact, toEvent, toStageRun, toTask } from "./serialize.ts";

export type { ApiAccess } from "./access.ts";

const PING_EVERY_MS = 15_000;
const DEFAULT_ACCESS: ApiAccess = { host: "127.0.0.1", port: DEFAULT_PORT, token: null };
/** Every `source.kind` a task may carry, for `GET /events?source=`. */
const SOURCE_KINDS: string[] = TaskSource.options.map((option) => option.shape.kind.value);
const IDEMPOTENCY_KEY_MAX = 200;
/** Activity entries returned with one task. */
const RECENT_EVENTS = 50;

export interface AppDeps {
  db: DataSource;
  pipeline: Pipeline;
  bus: Bus;
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
  /** Jira by hand (link, unlink, create, search, status); without it the `/jira/*` and `/tasks/:id/jira*` routes are absent. */
  jira?: JiraTasksPort;
  /** The ticket's SLA clocks, computed when a task is answered or published; without it every task shows `sla: null`. */
  sla?: (task: TaskRow) => Promise<TaskSla | null>;
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
}

class BadRequest extends Error {}

/** The client closed the request first (nginx's 499): nobody reads it, the log does. */
const CLIENT_CLOSED = 499;

const fail = (c: Context, status: 400 | 404 | 409 | 422 | 429 | 500 | 503 | typeof CLIENT_CLOSED, error: string, message: string, extra: Record<string, unknown> = {}) =>
  c.json<ApiError>({ error, message, ...extra }, status as ContentfulStatusCode);

/** `X-Luna-Client`: who calls `POST /runs` (`notch`), for its record. */
const CLIENT_NAME = /^[\w.-]{1,64}$/;

async function body<T>(c: Context, schema: ZodType<T>): Promise<T> {
  let json: unknown;
  try {
    json = await c.req.json();
  } catch {
    throw new BadRequest("body must be JSON");
  }
  return schema.parse(json);
}

/** Task ids are UUIDs; anything else cannot exist, so it is a 404 rather than a SQL error. */
function taskId(c: Context): string {
  const id = c.req.param("id") ?? "";
  if (!z.uuid().safeParse(id).success) throw new TaskNotFoundError(id);
  return id;
}

/** `owner`, `name` and a positive integer `number` from a `/github/prs/:owner/:name/:number/*` route. */
function prParams(c: Context): { owner: string; name: string; number: number } {
  const owner = c.req.param("owner") ?? "";
  const name = c.req.param("name") ?? "";
  const number = Number(c.req.param("number"));
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(name) || !Number.isInteger(number) || number < 1) {
    throw new BadRequest("the PR must be /github/prs/<owner>/<name>/<number>");
  }
  return { owner, name, number };
}

/** A task's `stages` name only packs that run in a task, each on an engine it allows. */
function checkStages(stages: Parameters<typeof taskStagesProblem>[0]): void {
  const problem = taskStagesProblem(stages);
  if (problem) throw new BadRequest(`stages.${problem}`);
}

export function createApp({ db, pipeline, bus, watcher, stubs, pulls, prTasks, taskDiff, slack, jira, sla, slaAll, credentials = machineCredentials(), engineBudgets, access = DEFAULT_ACCESS, runs }: AppDeps): Hono {
  const app = new Hono();
  engineBudgets ??= new EngineBudgetWatch({ budgets: {}, spend: new PgTaskStore(db), onAlert: () => {} });
  app.use(guard(access));
  /** A task row as the board reads it, clocks included. */
  const serialize = async (row: TaskRow, usage: { spentUsd: number; workedMs: number } | null = null) =>
    toTask(row, usage, sla ? await sla(row) : null, await pipeline.glance(row.id));

  app.onError((error, c) => {
    if (error instanceof TaskNotFoundError) return fail(c, 404, "not_found", error.message);
    if (error instanceof TransitionError) return fail(c, 409, "invalid_transition", error.message);
    if (error instanceof TaskBusyError) return fail(c, 409, "task_busy", error.message);
    if (error instanceof IdempotencyConflictError) return c.json<ApiError>({ error: "idempotency_conflict", message: error.message, taskId: error.taskId }, 409);
    if (error instanceof NoPlanToEditError) return fail(c, 409, "no_plan", error.message);
    if (error instanceof NoCasesToEditError) return fail(c, 409, "no_cases", error.message);
    if (error instanceof ApproverRequiredError) return fail(c, 400, "approver_required", error.message);
    if (error instanceof SameApproverError) return fail(c, 409, "same_approver", error.message);
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
    console.error(error);
    return fail(c, 500, "internal", error.message);
  });

  app.get("/health", (c) => c.json({ ok: true, slots: pipeline.slots }));

  /** Every pack in the registry, with the task states it runs in. */
  app.get("/packs", (c) => c.json(PackId.options.map((id) => packInfo(PACKS[id]))));

  /** Every engine, and whether this machine has the credential it needs; never the credential. */
  app.get("/engines", async (c) => {
    const standings = await engineBudgets.standings();
    return c.json(await Promise.all(EngineId.options.map(async (id) => engineInfo(id, await credentials.check(id), standings.get(id)))));
  });

  /** One context-only pack on data the client sends: its validated answer and what it cost. */
  app.post("/runs", async (c) => {
    const input = await body(c, RunInput);
    const client = c.req.header("x-luna-client") ?? null;
    if (client !== null && !CLIENT_NAME.test(client)) throw new BadRequest("X-Luna-Client must be 1 to 64 letters, digits, dots, dashes or underscores");
    if (!runs) return fail(c, 503, "agents_off", "this machine runs no packs: agents are off (MACHINE_AGENTS=off)");
    // The request's own signal: a client that leaves is dropped from the queue, or its container stopped.
    return c.json(await runs.run(input, client, c.req.raw.signal));
  });

  // "Stop picking up work" / "carry on" / "run N at once": the knobs for leaving and for debugging.
  app.post("/drain", (c) => c.json(pipeline.drain()));
  app.post("/resume", (c) => c.json(pipeline.resumeClaims()));
  app.patch("/slots", async (c) => {
    const { max } = await body(c, SlotsInput);
    return c.json(pipeline.setSlots(max));
  });

  app.get("/metrics", async (c) => {
    let since: Date;
    try {
      since = parseSince(c.req.query("since"));
    } catch (error) {
      if (error instanceof InvalidSince) throw new BadRequest(error.message);
      throw error;
    }
    const budget = { ...pipeline.budget, spentTodayUsd: await pipeline.spentTodayUsd() };
    const groupBy = c.req.query("groupBy");
    if (groupBy !== undefined && !(METRICS_GROUP_BY as readonly string[]).includes(groupBy)) throw new BadRequest(`groupBy must be one of ${METRICS_GROUP_BY.join(", ")}, got "${groupBy}"`);
    const repo = c.req.query("repo");
    return c.json(
      await computeMetrics(db, {
        since,
        slots: pipeline.slots,
        budget,
        ...(repo !== undefined ? { repo: repo === "" ? null : repo } : {}),
        ...(groupBy !== undefined ? { groupBy: groupBy as MetricsGroupBy } : {}),
      }),
    );
  });

  app.get("/tasks", async (c) => {
    const [rows, usage] = await Promise.all([pipeline.list(), pipeline.usageByTask()]);
    const glances = await pipeline.glances(rows.map((row) => row.id));
    const clocks = slaAll ? await slaAll(rows) : new Map(await Promise.all(rows.map(async (row) => [row.id, sla ? await sla(row) : null] as const)));
    return c.json(rows.map((row) => toTask(row, usage.get(row.id) ?? null, clocks.get(row.id) ?? null, glances.get(row.id) ?? null)));
  });

  /** A work order: with an `Idempotency-Key`, a retry answers the task already made (200); `start` starts it too. */
  app.post("/tasks", async (c) => {
    const input = await body(c, NewTaskInput);
    checkStages(input.stages ?? {});
    const key = c.req.header("idempotency-key");
    if (key !== undefined && (key.length === 0 || key.length > IDEMPOTENCY_KEY_MAX)) {
      throw new BadRequest(`Idempotency-Key must be 1 to ${IDEMPOTENCY_KEY_MAX} characters`);
    }
    const { task, created } = key === undefined ? { task: await pipeline.createTask(input), created: true } : await pipeline.createTaskOnce(input, key);
    // A retry may race the first call's start, or follow a first call that died before it: start once.
    const started = input.start && task.state === "draft" ? await pipeline.start(task.id).catch((error: unknown) => {
      if (error instanceof TransitionError) return pipeline.get(task.id);
      throw error;
    }) : task;
    return c.json(await serialize(started), created ? 201 : 200);
  });

  app.get("/tasks/:id", async (c) => {
    const id = taskId(c);
    const [task, stageRuns, approvals, events, artifacts, usage, reports] = await Promise.all([
      pipeline.get(id),
      pipeline.stageRuns(id),
      pipeline.approvals(id),
      pipeline.events(id),
      pipeline.artifacts(id),
      pipeline.taskUsage(id),
      pipeline.reports(id),
    ]);
    return c.json({
      task: await serialize(task, usage),
      stageRuns: stageRuns.map(toStageRun),
      approvals: approvals.map(toApproval),
      events: events.slice(-RECENT_EVENTS).map(toEvent),
      artifacts: artifacts.map(toArtifact),
      reports,
    });
  });

  app.patch("/tasks/:id", async (c) => {
    const id = taskId(c);
    const patch = await body(c, UpdateTaskInput);
    const task = await serialize(await pipeline.update(id, patch));
    bus.publish({ type: "task.updated", task, seq: task.seq });
    return c.json(task);
  });

  app.patch("/tasks/:id/plan", async (c) => {
    const id = taskId(c);
    const patch = await body(c, EditPlanInput);
    const task = await serialize(await pipeline.editPlan(id, patch));
    bus.publish({ type: "task.updated", task, seq: task.seq });
    return c.json(task);
  });

  app.patch("/tasks/:id/cases", async (c) => {
    const id = taskId(c);
    const { cases } = await body(c, EditCasesInput);
    const task = await serialize(await pipeline.editCases(id, cases));
    bus.publish({ type: "task.updated", task, seq: task.seq });
    return c.json(task);
  });

  /** Change the engine a pack runs on for this task, until that pack's stage starts. */
  app.patch("/tasks/:id/stages", async (c) => {
    const id = taskId(c);
    const { stages } = await body(c, EditStagesInput);
    checkStages(stages);
    const task = await serialize(await pipeline.setStages(id, stages));
    bus.publish({ type: "task.updated", task, seq: task.seq });
    return c.json(task);
  });

  if (taskDiff) {
    /** The branch against its base, one row per file; `?file=<path>` adds that file's patch (404 no_file unless the path is one of the rows). */
    app.get("/tasks/:id/diff", async (c) => {
      const task = await pipeline.get(taskId(c));
      if (!task.worktreePath) throw new NoWorktreeError(null);
      const file = c.req.query("file");
      return c.json(await taskDiff(task.worktreePath, task.repoPath, file === undefined || file === "" ? undefined : file));
    });
  }

  app.delete("/tasks/:id", async (c) => {
    const id = taskId(c);
    const seq = await pipeline.delete(id);
    await watcher?.close(id);
    bus.publish({ type: "task.deleted", id, seq });
    return c.body(null, 204);
  });

  app.post("/tasks/:id/start", async (c) => c.json(await serialize(await pipeline.start(taskId(c)))));

  app.post("/repos/setup", async (c) => {
    const { repoPath } = await body(c, SetupRepoInput);
    return c.json(await serialize(await pipeline.setupRepo(repoPath)), 201);
  });

  app.post("/tasks/:id/answers", async (c) => {
    const id = taskId(c);
    const { answers } = await body(c, AnswersInput);
    return c.json(await serialize(await pipeline.answer(id, answers)));
  });

  /** Approves or sends back whatever the task is waiting on, including an escalation. */
  app.post("/tasks/:id/decision", async (c) => {
    const id = taskId(c);
    const { decision, reason, applyRules, approver } = await body(c, DecisionInput);
    const response = applyRules === undefined ? undefined : { applyRules };
    return c.json(await serialize(await pipeline.decide(id, decision, reason ?? undefined, response, approver ? { approver } : {})));
  });

  /** Ends the task as archived with a reason (duplicate, sla_expired, rejected, not_for_agent, pr_closed). */
  app.post("/tasks/:id/archive", async (c) => {
    const id = taskId(c);
    const { reason } = await body(c, ArchiveInput);
    const task = await serialize(await pipeline.archive(id, reason));
    bus.publish({ type: "task.updated", task, seq: task.seq });
    return c.json(task);
  });

  app.post("/tasks/:id/abort", async (c) => c.json(await serialize(await pipeline.abort(taskId(c)))));

  /** Re-runs the stage a task paused in after a usage limit. */
  app.post("/tasks/:id/resume", async (c) => c.json(await serialize(await pipeline.windowReset(taskId(c)))));

  /** Removes the task's worktree from disk; the task and its branch stay. */
  app.post("/tasks/:id/worktree/remove", async (c) => c.json(await serialize(await pipeline.removeWorktree(taskId(c)))));

  if (pulls) {
    // The PR inbox: what the last poll saw, a poll on demand, a merge, and a clone for a repo
    // the machine has no checkout of. Actions on a PR are `POST .../actions` (pr-tasks).
    app.get("/github/prs", (c) => c.json(pulls.snapshot));
    app.post("/github/prs/refresh", async (c) => c.json(await pulls.pollOnce()));
    app.post("/github/prs/:owner/:name/:number/merge", async (c) => {
      const { owner, name, number } = prParams(c);
      await pulls.merge(`${owner}/${name}`, number);
      return c.json({ merged: true });
    });
    app.post("/github/prs/:owner/:name/:number/close", async (c) => {
      const { owner, name, number } = prParams(c);
      await pulls.close(`${owner}/${name}`, number);
      return c.json({ closed: true });
    });
    if (prTasks) {
      app.post("/github/prs/:owner/:name/:number/actions", async (c) => {
        const { owner, name, number } = prParams(c);
        const { action } = await body(c, PrActionInput);
        const slug = `${owner}/${name}`.toLowerCase();
        const pr = pulls.snapshot.prs.find((p) => p.repo.toLowerCase() === slug && p.number === number);
        if (!pr) throw new TaskNotFoundError(`${owner}/${name}#${number}`);
        return c.json(await serialize(await prTasks.dispatch(pr, action)), 201);
      });
    }
    app.post("/github/clone", async (c) => {
      const { repo, dest } = await body(c, CloneInput);
      await pulls.clone(repo, dest);
      return c.json({ repo, dest, cloning: true }, 202);
    });
  }

  if (slack) {
    // The Slack inbox: the snapshot, a poll on demand, your actions on an item, the watches,
    // how fast you answer, and the listings the board's watch popup completes from.
    app.get("/slack/items", (c) => c.json(slack.snapshot));
    app.post("/slack/refresh", async (c) => c.json(await slack.pollOnce(true)));
    app.patch("/slack/items/:id", async (c) => c.json(await slack.patch(c.req.param("id"), await body(c, SlackItemPatch))));
    app.post("/slack/items/:id/reply", async (c) => {
      const { text, nudge } = await body(c, SlackReplyInput);
      return c.json(await slack.reply(c.req.param("id"), text, nudge ?? false));
    });
    app.post("/slack/items/:id/task", async (c) => c.json(await serialize(await slack.toTask(c.req.param("id"), await body(c, SlackTaskInput))), 201));
    app.get("/slack/watches", async (c) => c.json(await slack.watches()));
    app.post("/slack/watches", async (c) => c.json(await slack.addWatch(await body(c, SlackWatchInput)), 201));
    app.patch("/slack/watches/:id", async (c) => c.json(await slack.patchWatch(c.req.param("id"), await body(c, SlackWatchPatch))));
    app.delete("/slack/watches/:id", async (c) => {
      await slack.deleteWatch(c.req.param("id"));
      return c.body(null, 204);
    });
    const sinceOf = (value: string | undefined): Date => {
      try {
        return parseSince(value);
      } catch (error) {
        if (error instanceof InvalidSince) throw new BadRequest(error.message);
        throw error;
      }
    };
    app.get("/slack/metrics", async (c) => c.json(await slack.metrics(sinceOf(c.req.query("since")))));
    // What the slack_triage pack cost: one row per container run, items and dollars summed.
    app.get("/slack/triage-runs", async (c) => c.json(await slack.triageRuns(sinceOf(c.req.query("since")))));
    app.get("/slack/usergroups", async (c) => c.json(await slack.usergroups()));
    app.get("/slack/channels", async (c) => c.json(await slack.channels()));
  }

  if (jira) {
    // Jira by hand (`J` on a ticket): link an issue, unlink it, create one from the ticket, search
    // issues to pick from, and whether the token works. The automatic part (JiraSync, JiraIntake,
    // JiraWatch) needs no route.
    app.get("/jira/status", async (c) => c.json(await jira.status()));
    app.get("/jira/search", async (c) => c.json(await jira.search(c.req.query("q") ?? "")));
    const linked = async (c: Context, task: TaskRow, status: 200 | 201 = 200) => {
      const out = await serialize(task, await pipeline.taskUsage(task.id));
      bus.publish({ type: "task.updated", task: out, seq: out.seq });
      return c.json(out, status);
    };
    app.post("/tasks/:id/jira", async (c) => {
      const id = taskId(c);
      const { key } = await body(c, JiraLinkInput);
      return linked(c, await jira.link(id, key));
    });
    app.delete("/tasks/:id/jira", async (c) => linked(c, await jira.unlink(taskId(c))));
    app.post("/tasks/:id/jira/create", async (c) => {
      const id = taskId(c);
      return linked(c, await jira.create(id, await body(c, JiraCreateInput)), 201);
    });
  }

  if (stubs) {
    app.post("/dev/stubs", async (c) => {
      const plan = await body(c, StubPlanInput);
      stubs.plan(TaskState.parse(plan.stage), ...plan.results);
      return c.json({ stage: plan.stage, queued: plan.results.length });
    });
  }

  /** Live updates; `since` replays the task changes past that sequence number first, `source` keeps one source's tasks (see replay.ts). `ready` follows the replay. */
  app.get("/events", (c) => {
    const since = c.req.query("since");
    const source = c.req.query("source") ?? null;
    const wanted = c.req.query("names");
    const names = wanted === undefined ? null : new Set(wanted.split(",").map((n) => n.trim()).filter((n) => n !== ""));
    for (const n of names ?? []) if (!CardEventName.safeParse(n).success) throw new BadRequest(`names must be diagram event names (${CARD_EVENT_NAMES.join(", ")}), got "${n.slice(0, 40)}"`);
    if (since !== undefined && !/^\d+$/.test(since)) throw new BadRequest(`since must be a sequence number, got "${since}"`);
    if (source !== null && !SOURCE_KINDS.includes(source)) throw new BadRequest(`source must be one of ${SOURCE_KINDS.join(", ")}, got "${source}"`);
    return streamSSE(c, async (stream) => {
      let unsubscribe = () => {};
      const write = (message: StreamMessage) =>
        stream.writeSSE({ event: message.type, data: JSON.stringify(message) }).catch((error: unknown) => {
          console.error(`SSE write failed, dropping this listener: ${error}`);
          unsubscribe();
        });
      const deps = {
        changesSince: (after: number, kind: string | null) => pipeline.changesSince(after, kind),
        lastSeq: () => pipeline.lastSeq(),
        serialize: async (row: TaskRow) => serialize(row, await pipeline.taskUsage(row.id)),
        sourceOf: (taskId: string) => pipeline.get(taskId).then((task) => task.source?.kind ?? null, () => null),
        write,
      };
      const feed = since === undefined && source === null && names === null ? null : new ReplayFeed(deps, since === undefined ? null : Number(since), source, names as ReadonlySet<CardEventName> | null);
      unsubscribe = bus.subscribe((message) => (feed ? feed.offer(message) : void write(message)));
      stream.onAbort(unsubscribe);

      await feed?.read();
      await stream.writeSSE({ event: "ready", data: "{}" });
      while (!stream.aborted) {
        await stream.sleep(PING_EVERY_MS);
        if (!stream.aborted) await stream.writeSSE({ event: "ping", data: "{}" });
      }
    });
  });

  return app;
}
