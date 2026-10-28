// The machine's HTTP API: commands for the board, and a Server-Sent Events stream of
// updates. Shapes are defined in @hardness/contracts.
import {
  AnswersInput,
  type ApiError,
  CloneInput,
  DecisionInput,
  type PrAction,
  PrActionInput,
  type PullRequest,
  EditCasesInput,
  EditPlanInput,
  type TaskDiff,
  NewTaskInput,
  SetupRepoInput,
  SlackItemPatch,
  SlackReplyInput,
  SlackTaskInput,
  SlackWatchInput,
  SlackWatchPatch,
  StubPlanInput,
  TaskState,
  UpdateTaskInput,
} from "@hardness/contracts";
import { type Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { DataSource } from "typeorm";
import { ZodError, type ZodType, z } from "zod";

const SlotsInput = z.object({ max: z.number().int().min(1) });

import { computeMetrics } from "../persistence/metrics-query.ts";
import type { TaskRow } from "../../domain/task.ts";
import { TransitionError } from "../../domain/transition.ts";
import type { Watcher } from "../../application/ports.ts";
import { NoCasesToEditError, NoPlanToEditError, type Pipeline, TaskBusyError, TaskNotFoundError } from "../../application/pipeline.ts";
import { NoWorktreeError } from "../git/diff.ts";
import { ForkError, NoCheckoutError, OwnPrError, PrBusyError } from "../../application/pr-tasks.ts";
import { CloneError, NotReadyError, type PullsPort } from "../../application/pulls.ts";
import { AlreadyTaskError, BuiltinWatchError, NoItemError, NoWatchError, type SlackInboxPort } from "../../application/slack-inbox.ts";
import { NoSlackTokenError } from "../../application/slack.ts";
import type { StubStages } from "../../application/stages/stubs.ts";
import type { Bus } from "./bus.ts";
import { InvalidSince, parseSince } from "./metrics.ts";
import { toApproval, toArtifact, toEvent, toStageRun, toTask } from "./serialize.ts";

const PING_EVERY_MS = 15_000;
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
}

class BadRequest extends Error {}

const fail = (c: Context, status: 400 | 404 | 409 | 500, error: string, message: string) =>
  c.json<ApiError>({ error, message }, status);

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

export function createApp({ db, pipeline, bus, watcher, stubs, pulls, prTasks, taskDiff, slack }: AppDeps): Hono {
  const app = new Hono();

  app.onError((error, c) => {
    if (error instanceof TaskNotFoundError) return fail(c, 404, "not_found", error.message);
    if (error instanceof TransitionError) return fail(c, 409, "invalid_transition", error.message);
    if (error instanceof TaskBusyError) return fail(c, 409, "task_busy", error.message);
    if (error instanceof NoPlanToEditError) return fail(c, 409, "no_plan", error.message);
    if (error instanceof NoCasesToEditError) return fail(c, 409, "no_cases", error.message);
    if (error instanceof NoWorktreeError) return fail(c, 404, "no_worktree", error.message);
    if (error instanceof NotReadyError) return fail(c, 409, "not_ready", error.message);
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
    if (error instanceof ZodError) return fail(c, 400, "invalid_request", z.prettifyError(error));
    if (error instanceof BadRequest) return fail(c, 400, "invalid_request", error.message);
    console.error(error);
    return fail(c, 500, "internal", error.message);
  });

  app.get("/health", (c) => c.json({ ok: true, slots: pipeline.slots }));

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
    if (groupBy !== undefined && groupBy !== "repo") throw new BadRequest(`groupBy must be repo, got "${groupBy}"`);
    const repo = c.req.query("repo");
    return c.json(
      await computeMetrics(db, {
        since,
        slots: pipeline.slots,
        budget,
        ...(repo !== undefined ? { repo: repo === "" ? null : repo } : {}),
        ...(groupBy === "repo" ? { groupBy } : {}),
      }),
    );
  });

  app.get("/tasks", async (c) => {
    const [rows, usage] = await Promise.all([pipeline.list(), pipeline.usageByTask()]);
    return c.json(rows.map((row) => toTask(row, usage.get(row.id) ?? null)));
  });

  app.post("/tasks", async (c) => {
    const input = await body(c, NewTaskInput);
    return c.json(toTask(await pipeline.createTask(input)), 201);
  });

  app.get("/tasks/:id", async (c) => {
    const id = taskId(c);
    const [task, stageRuns, approvals, events, artifacts, usage] = await Promise.all([
      pipeline.get(id),
      pipeline.stageRuns(id),
      pipeline.approvals(id),
      pipeline.events(id),
      pipeline.artifacts(id),
      pipeline.taskUsage(id),
    ]);
    return c.json({
      task: toTask(task, usage),
      stageRuns: stageRuns.map(toStageRun),
      approvals: approvals.map(toApproval),
      events: events.slice(-RECENT_EVENTS).map(toEvent),
      artifacts: artifacts.map(toArtifact),
    });
  });

  app.patch("/tasks/:id", async (c) => {
    const id = taskId(c);
    const patch = await body(c, UpdateTaskInput);
    const task = toTask(await pipeline.update(id, patch));
    bus.publish({ type: "task.updated", task });
    return c.json(task);
  });

  app.patch("/tasks/:id/plan", async (c) => {
    const id = taskId(c);
    const patch = await body(c, EditPlanInput);
    const task = toTask(await pipeline.editPlan(id, patch));
    bus.publish({ type: "task.updated", task });
    return c.json(task);
  });

  app.patch("/tasks/:id/cases", async (c) => {
    const id = taskId(c);
    const { cases } = await body(c, EditCasesInput);
    const task = toTask(await pipeline.editCases(id, cases));
    bus.publish({ type: "task.updated", task });
    return c.json(task);
  });

  if (taskDiff) {
    /** The branch against its base, one row per file; `?file=<path>` adds that file's patch. */
    app.get("/tasks/:id/diff", async (c) => {
      const task = await pipeline.get(taskId(c));
      if (!task.worktreePath) throw new NoWorktreeError(null);
      const file = c.req.query("file");
      return c.json(await taskDiff(task.worktreePath, task.repoPath, file === undefined || file === "" ? undefined : file));
    });
  }

  app.delete("/tasks/:id", async (c) => {
    const id = taskId(c);
    await pipeline.delete(id);
    await watcher?.close(id);
    bus.publish({ type: "task.deleted", id });
    return c.body(null, 204);
  });

  app.post("/tasks/:id/start", async (c) => c.json(toTask(await pipeline.start(taskId(c)))));

  app.post("/repos/setup", async (c) => {
    const { repoPath } = await body(c, SetupRepoInput);
    return c.json(toTask(await pipeline.setupRepo(repoPath)), 201);
  });

  app.post("/tasks/:id/answers", async (c) => {
    const id = taskId(c);
    const { answers } = await body(c, AnswersInput);
    return c.json(toTask(await pipeline.answer(id, answers)));
  });

  /** Approves or sends back whatever the task is waiting on, including an escalation. */
  app.post("/tasks/:id/decision", async (c) => {
    const id = taskId(c);
    const { decision, reason, applyRules } = await body(c, DecisionInput);
    const response = applyRules === undefined ? undefined : { applyRules };
    return c.json(toTask(await pipeline.decide(id, decision, reason ?? undefined, response)));
  });

  app.post("/tasks/:id/abort", async (c) => c.json(toTask(await pipeline.abort(taskId(c)))));

  /** Re-runs the stage a task paused in after a usage limit. */
  app.post("/tasks/:id/resume", async (c) => c.json(toTask(await pipeline.windowReset(taskId(c)))));

  /** Removes the task's worktree from disk; the task and its branch stay. */
  app.post("/tasks/:id/worktree/remove", async (c) => c.json(toTask(await pipeline.removeWorktree(taskId(c)))));

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
    if (prTasks) {
      app.post("/github/prs/:owner/:name/:number/actions", async (c) => {
        const { owner, name, number } = prParams(c);
        const { action } = await body(c, PrActionInput);
        const slug = `${owner}/${name}`.toLowerCase();
        const pr = pulls.snapshot.prs.find((p) => p.repo.toLowerCase() === slug && p.number === number);
        if (!pr) throw new TaskNotFoundError(`${owner}/${name}#${number}`);
        return c.json(toTask(await prTasks.dispatch(pr, action)), 201);
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
    app.post("/slack/refresh", async (c) => c.json(await slack.pollOnce()));
    app.patch("/slack/items/:id", async (c) => c.json(await slack.patch(c.req.param("id"), await body(c, SlackItemPatch))));
    app.post("/slack/items/:id/reply", async (c) => {
      const { text } = await body(c, SlackReplyInput);
      return c.json(await slack.reply(c.req.param("id"), text));
    });
    app.post("/slack/items/:id/task", async (c) => c.json(toTask(await slack.toTask(c.req.param("id"), await body(c, SlackTaskInput))), 201));
    app.get("/slack/watches", async (c) => c.json(await slack.watches()));
    app.post("/slack/watches", async (c) => c.json(await slack.addWatch(await body(c, SlackWatchInput)), 201));
    app.patch("/slack/watches/:id", async (c) => c.json(await slack.patchWatch(c.req.param("id"), await body(c, SlackWatchPatch))));
    app.delete("/slack/watches/:id", async (c) => {
      await slack.deleteWatch(c.req.param("id"));
      return c.body(null, 204);
    });
    app.get("/slack/metrics", async (c) => {
      let since: Date;
      try {
        since = parseSince(c.req.query("since"));
      } catch (error) {
        if (error instanceof InvalidSince) throw new BadRequest(error.message);
        throw error;
      }
      return c.json(await slack.metrics(since));
    });
    app.get("/slack/usergroups", async (c) => c.json(await slack.usergroups()));
    app.get("/slack/channels", async (c) => c.json(await slack.channels()));
  }

  if (stubs) {
    app.post("/dev/stubs", async (c) => {
      const plan = await body(c, StubPlanInput);
      stubs.plan(TaskState.parse(plan.stage), ...plan.results);
      return c.json({ stage: plan.stage, queued: plan.results.length });
    });
  }

  app.get("/events", (c) =>
    streamSSE(c, async (stream) => {
      let unsubscribe = () => {};
      unsubscribe = bus.subscribe((message) => {
        stream.writeSSE({ event: message.type, data: JSON.stringify(message) }).catch((error: unknown) => {
          console.error(`SSE write failed, dropping this listener: ${error}`);
          unsubscribe();
        });
      });
      stream.onAbort(unsubscribe);

      await stream.writeSSE({ event: "ready", data: "{}" });
      while (!stream.aborted) {
        await stream.sleep(PING_EVERY_MS);
        if (!stream.aborted) await stream.writeSSE({ event: "ping", data: "{}" });
      }
    }),
  );

  return app;
}
