// Tasks: the cards, their edits, gates and actions.
import { TransitionError } from "../../../domain/transition.ts";
import { NoWorktreeError } from "../../git/diff.ts";
import { toApproval, toArtifact, toEvent, toStageRun, toTask } from "../serialize.ts";
import { createOpenApiRouter } from "../openapi/router.ts";
import { IDEMPOTENCY_KEY_MAX, RECENT_EVENTS, BadRequest, taskId, checkStages, type RouteDeps } from "./kit.ts";
import * as r from "./tasks.openapi.ts";

export function tasksRoutes(deps: RouteDeps) {
  const { pipeline, bus, watcher, taskDiff, sla, slaAll, shipView, runs, serialize } = deps;
  const app = createOpenApiRouter();
  app.openapi(r.listTasksRoute, async (c) => {
    const [rows, usage] = await Promise.all([pipeline.list(), pipeline.usageByTask()]);
    const glances = await pipeline.glances(rows.map((row) => row.id));
    const clocks = slaAll ? await slaAll(rows) : new Map(await Promise.all(rows.map(async (row) => [row.id, sla ? await sla(row) : null] as const)));
    return c.json(rows.map((row) => toTask(row, usage.get(row.id) ?? null, clocks.get(row.id) ?? null, glances.get(row.id) ?? null)), 200);
  });

  /** A work order: with an `Idempotency-Key`, a retry answers the task already made (200); `start` starts it too. */
  app.openapi(r.createTaskRoute, async (c) => {
    const input = c.req.valid("json");
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

  app.openapi(r.getTaskRoute, async (c) => {
    const id = taskId(c);
    const [task, stageRuns, approvals, events, artifacts, usage, reports, buildProgress] = await Promise.all([
      pipeline.get(id),
      pipeline.stageRuns(id),
      pipeline.approvals(id),
      pipeline.events(id),
      pipeline.artifacts(id),
      pipeline.taskUsage(id),
      pipeline.reports(id),
      pipeline.buildProgress(id),
    ]);
    return c.json({
      task: await serialize(task, usage),
      stageRuns: stageRuns.map(toStageRun),
      approvals: approvals.map(toApproval),
      events: events.slice(-RECENT_EVENTS).map(toEvent),
      artifacts: artifacts.map(toArtifact),
      reports,
      buildProgress,
      ship: (await shipView?.(id).catch(() => null)) ?? null,
    }, 200);
  });

  app.openapi(r.updateTaskRoute, async (c) => {
    const id = taskId(c);
    const patch = c.req.valid("json");
    const task = await serialize(await pipeline.update(id, patch));
    bus.publish({ type: "task.updated", task, seq: task.seq });
    return c.json(task, 200);
  });

  app.openapi(r.editPlanRoute, async (c) => {
    const id = taskId(c);
    const patch = c.req.valid("json");
    const task = await serialize(await pipeline.editPlan(id, patch));
    bus.publish({ type: "task.updated", task, seq: task.seq });
    return c.json(task, 200);
  });

  /** A person's correction of the Triage Record while the card waits at a gate: enum values only. */
  app.openapi(r.editRecordRoute, async (c) => {
    const id = taskId(c);
    const patch = c.req.valid("json");
    const task = await serialize(await pipeline.editRecord(id, patch));
    bus.publish({ type: "task.updated", task, seq: task.seq });
    return c.json(task, 200);
  });

  /** A person's tap: post the open questions where the card came from. Idempotent. */
  app.openapi(r.postQuestionsRoute, async (c) => {
    const id = taskId(c);
    const { task, posted } = await pipeline.postQuestions(id);
    return c.json({ ...(await serialize(task)), posted }, 200);
  });

  app.openapi(r.editCasesRoute, async (c) => {
    const id = taskId(c);
    const { cases } = c.req.valid("json");
    const task = await serialize(await pipeline.editCases(id, cases));
    bus.publish({ type: "task.updated", task, seq: task.seq });
    return c.json(task, 200);
  });

  /** Change the engine a pack runs on for this task, until that pack's stage starts. */
  app.openapi(r.editStagesRoute, async (c) => {
    const id = taskId(c);
    const { stages } = c.req.valid("json");
    checkStages(stages);
    const task = await serialize(await pipeline.setStages(id, stages));
    bus.publish({ type: "task.updated", task, seq: task.seq });
    return c.json(task, 200);
  });

  if (taskDiff) {
    /** The branch against its base, one row per file; `?file=<path>` adds that file's patch (404 no_file unless the path is one of the rows). */
    app.openapi(r.taskDiffRoute, async (c) => {
      const task = await pipeline.get(taskId(c));
      if (!task.worktreePath) throw new NoWorktreeError(null);
      const file = c.req.query("file");
      return c.json(await taskDiff(task.worktreePath, task.repoPath, file === undefined || file === "" ? undefined : file), 200);
    });
  }

  app.openapi(r.deleteTaskRoute, async (c) => {
    const id = taskId(c);
    const seq = await pipeline.delete(id);
    await watcher?.close(id);
    bus.publish({ type: "task.deleted", id, seq });
    return c.body(null, 204);
  });

  app.openapi(r.startTaskRoute, async (c) => c.json(await serialize(await pipeline.start(taskId(c))), 200));

  app.openapi(r.answersRoute, async (c) => {
    const id = taskId(c);
    const { answers } = c.req.valid("json");
    return c.json(await serialize(await pipeline.answer(id, answers)), 200);
  });

  /** Approves or sends back whatever the task is waiting on, including an escalation. */
  app.openapi(r.decisionRoute, async (c) => {
    const id = taskId(c);
    const { decision, reason, comment, applyRules, approver, keepWhole, untestable, design } = c.req.valid("json");
    const response = applyRules === undefined && keepWhole === undefined && untestable === undefined && design === undefined ? undefined : { ...(applyRules === undefined ? {} : { applyRules }), ...(keepWhole === undefined ? {} : { keepWhole }), ...(untestable === undefined ? {} : { untestable }), ...(design === undefined ? {} : { design }) };
    return c.json(await serialize(await pipeline.decide(id, decision, reason ?? comment ?? undefined, response, approver ? { approver } : {})), 200);
  });

  /** Corrects the reason an escalation was decided with (the enum only); the card stays at its escalated gate. */
  app.openapi(r.escalationReasonRoute, async (c) => {
    const id = taskId(c);
    const { reason } = c.req.valid("json");
    return c.json(await serialize(await pipeline.correctEscalationReason(id, reason)), 200);
  });

  /** Ends the task as archived with a reason (duplicate, sla_expired, rejected, not_for_agent, pr_closed). */
  app.openapi(r.archiveRoute, async (c) => {
    const id = taskId(c);
    const { reason } = c.req.valid("json");
    const task = await serialize(await pipeline.archive(id, reason));
    bus.publish({ type: "task.updated", task, seq: task.seq });
    return c.json(task, 200);
  });

  /** Intake's context gate: a person picks the repository or project, or adds text; the card goes back through the check. */
  app.openapi(r.contextRoute, async (c) => {
    const id = taskId(c);
    const task = await serialize(await pipeline.provideContext(id, c.req.valid("json")));
    bus.publish({ type: "task.updated", task, seq: task.seq });
    return c.json(task, 200);
  });

  /** Intake's dedup gate: "duplicate of one", "related to some" or "neither". */
  app.openapi(r.dedupRoute, async (c) => {
    const id = taskId(c);
    const task = await serialize(await pipeline.answerDedup(id, c.req.valid("json")));
    bus.publish({ type: "task.updated", task, seq: task.seq });
    return c.json(task, 200);
  });

  /** A person marks the task as a duplicate of another card: its report merges into it. */
  app.openapi(r.mergeRoute, async (c) => {
    const id = taskId(c);
    const { into } = c.req.valid("json");
    const task = await serialize(await pipeline.merge(id, into));
    bus.publish({ type: "task.updated", task, seq: task.seq });
    return c.json(task, 200);
  });

  /** A person undoes a merge: the duplicate comes back as a new card. */
  app.openapi(r.unmergeRoute, async (c) => {
    const task = await serialize(await pipeline.unmerge(taskId(c)));
    bus.publish({ type: "task.updated", task, seq: task.seq });
    return c.json(task, 200);
  });

  /** A person's thumbs on the card's Evidence Pack: useful or not, with a short note. A card with no pack is a 409 (no_evidence). */
  app.openapi(r.evidenceFeedbackRoute, async (c) => {
    const id = taskId(c);
    const { useful, note } = c.req.valid("json");
    await pipeline.evidenceFeedback(id, { useful, note });
    return c.json(await serialize(await pipeline.get(id)), 200);
  });

  /** A person dismisses one of the findings the last Verify reported, while the card waits at awaiting_ship. */
  app.openapi(r.dismissFindingRoute, async (c) => {
    const id = taskId(c);
    const { reason } = c.req.valid("json");
    await pipeline.dismissFinding(id, c.req.param("findingId").slice(0, 200), reason);
    return c.json(await serialize(await pipeline.get(id)), 200);
  });

  /** A person waives one design finding at the design sign-off, with a kind and a reason (RFC 0013): not at any other gate (409), not a finding the gate does not hold (404). */
  app.openapi(r.waiveDesignFindingRoute, async (c) => {
    const id = taskId(c);
    const input = c.req.valid("json");
    await pipeline.waiveDesignFinding(id, c.req.param("findingId").slice(0, 200), input);
    return c.json(await serialize(await pipeline.get(id)), 200);
  });

  /** A person adds a finding Verify missed. */
  app.openapi(r.addFindingRoute, async (c) => {
    const id = taskId(c);
    await pipeline.addFinding(id, c.req.valid("json"));
    return c.json(await serialize(await pipeline.get(id)), 200);
  });

  app.openapi(r.abortRoute, async (c) => c.json(await serialize(await pipeline.abort(taskId(c))), 200));

  /** Re-runs the stage a task paused in after a usage limit. */
  app.openapi(r.resumeRoute, async (c) => c.json(await serialize(await pipeline.windowReset(taskId(c))), 200));

  /** Removes the task's worktree from disk; the task and its branch stay. */
  app.openapi(r.removeWorktreeRoute, async (c) => c.json(await serialize(await pipeline.removeWorktree(taskId(c), { discard: c.req.query("discard") === "true" })), 200));
  return app;
}
