// The machine's HTTP API: commands for the board, and a Server-Sent Events stream of
// updates. Shapes are defined in @hardness/contracts.
import {
  AnswersInput,
  type ApiError,
  DecisionInput,
  EditPlanInput,
  NewTaskInput,
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
import { TransitionError } from "../../domain/transition.ts";
import type { Watcher } from "../../application/ports.ts";
import { NoPlanToEditError, type Pipeline, TaskBusyError, TaskNotFoundError } from "../../application/pipeline.ts";
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

export function createApp({ db, pipeline, bus, watcher, stubs }: AppDeps): Hono {
  const app = new Hono();

  app.onError((error, c) => {
    if (error instanceof TaskNotFoundError) return fail(c, 404, "not_found", error.message);
    if (error instanceof TransitionError) return fail(c, 409, "invalid_transition", error.message);
    if (error instanceof TaskBusyError) return fail(c, 409, "task_busy", error.message);
    if (error instanceof NoPlanToEditError) return fail(c, 409, "no_plan", error.message);
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
    return c.json(await computeMetrics(db, { since, slots: pipeline.slots, budget }));
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

  app.delete("/tasks/:id", async (c) => {
    const id = taskId(c);
    await pipeline.delete(id);
    await watcher?.close(id);
    bus.publish({ type: "task.deleted", id });
    return c.body(null, 204);
  });

  app.post("/tasks/:id/start", async (c) => c.json(toTask(await pipeline.start(taskId(c)))));

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
