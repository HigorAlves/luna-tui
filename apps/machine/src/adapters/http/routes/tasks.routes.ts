// Tasks: the cards, their edits, gates and actions.
import { AnswersInput, ArchiveInput, AddFindingInput, DismissFindingInput, WaiveDesignFindingInput, EvidenceFeedbackInput, DecisionInput, EscalationReasonInput, EditCasesInput, EditPlanInput, EditRecordInput, EditStagesInput, ContextInput, DedupAnswerInput, MergeCardInput, NewTaskInput, UpdateTaskInput } from "@hardness/contracts";
import { TransitionError } from "../../../domain/transition.ts";
import { NoWorktreeError } from "../../git/diff.ts";
import { toApproval, toArtifact, toEvent, toStageRun, toTask } from "../serialize.ts";
import { createOpenApiRouter } from "../openapi/router.ts";
import { IDEMPOTENCY_KEY_MAX, RECENT_EVENTS, BadRequest, body, taskId, checkStages, type RouteDeps } from "./kit.ts";

export function tasksRoutes(deps: RouteDeps) {
  const { pipeline, bus, watcher, taskDiff, sla, slaAll, shipView, runs, serialize } = deps;
  const app = createOpenApiRouter();
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

  /** A person's correction of the Triage Record while the card waits at a gate: enum values only. */
  app.patch("/tasks/:id/record", async (c) => {
    const id = taskId(c);
    const patch = await body(c, EditRecordInput);
    const task = await serialize(await pipeline.editRecord(id, patch));
    bus.publish({ type: "task.updated", task, seq: task.seq });
    return c.json(task);
  });

  /** A person's tap: post the open questions where the card came from. Idempotent. */
  app.post("/tasks/:id/questions/post", async (c) => {
    const id = taskId(c);
    const { task, posted } = await pipeline.postQuestions(id);
    return c.json({ ...(await serialize(task)), posted });
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

  app.post("/tasks/:id/answers", async (c) => {
    const id = taskId(c);
    const { answers } = await body(c, AnswersInput);
    return c.json(await serialize(await pipeline.answer(id, answers)));
  });

  /** Approves or sends back whatever the task is waiting on, including an escalation. */
  app.post("/tasks/:id/decision", async (c) => {
    const id = taskId(c);
    const { decision, reason, comment, applyRules, approver, keepWhole, untestable, design } = await body(c, DecisionInput);
    const response = applyRules === undefined && keepWhole === undefined && untestable === undefined && design === undefined ? undefined : { ...(applyRules === undefined ? {} : { applyRules }), ...(keepWhole === undefined ? {} : { keepWhole }), ...(untestable === undefined ? {} : { untestable }), ...(design === undefined ? {} : { design }) };
    return c.json(await serialize(await pipeline.decide(id, decision, reason ?? comment ?? undefined, response, approver ? { approver } : {})));
  });

  /** Corrects the reason an escalation was decided with (the enum only); the card stays at its escalated gate. */
  app.post("/tasks/:id/escalation-reason", async (c) => {
    const id = taskId(c);
    const { reason } = await body(c, EscalationReasonInput);
    return c.json(await serialize(await pipeline.correctEscalationReason(id, reason)));
  });

  /** Ends the task as archived with a reason (duplicate, sla_expired, rejected, not_for_agent, pr_closed). */
  app.post("/tasks/:id/archive", async (c) => {
    const id = taskId(c);
    const { reason } = await body(c, ArchiveInput);
    const task = await serialize(await pipeline.archive(id, reason));
    bus.publish({ type: "task.updated", task, seq: task.seq });
    return c.json(task);
  });

  /** Intake's context gate: a person picks the repository or project, or adds text; the card goes back through the check. */
  app.post("/tasks/:id/context", async (c) => {
    const id = taskId(c);
    const task = await serialize(await pipeline.provideContext(id, await body(c, ContextInput)));
    bus.publish({ type: "task.updated", task, seq: task.seq });
    return c.json(task);
  });

  /** Intake's dedup gate: "duplicate of one", "related to some" or "neither". */
  app.post("/tasks/:id/dedup", async (c) => {
    const id = taskId(c);
    const task = await serialize(await pipeline.answerDedup(id, await body(c, DedupAnswerInput)));
    bus.publish({ type: "task.updated", task, seq: task.seq });
    return c.json(task);
  });

  /** A person marks the task as a duplicate of another card: its report merges into it. */
  app.post("/tasks/:id/merge", async (c) => {
    const id = taskId(c);
    const { into } = await body(c, MergeCardInput);
    const task = await serialize(await pipeline.merge(id, into));
    bus.publish({ type: "task.updated", task, seq: task.seq });
    return c.json(task);
  });

  /** A person undoes a merge: the duplicate comes back as a new card. */
  app.post("/tasks/:id/unmerge", async (c) => {
    const task = await serialize(await pipeline.unmerge(taskId(c)));
    bus.publish({ type: "task.updated", task, seq: task.seq });
    return c.json(task);
  });

  /** A person's thumbs on the card's Evidence Pack: useful or not, with a short note. A card with no pack is a 409 (no_evidence). */
  app.post("/tasks/:id/evidence/feedback", async (c) => {
    const id = taskId(c);
    const { useful, note } = await body(c, EvidenceFeedbackInput);
    await pipeline.evidenceFeedback(id, { useful, note });
    return c.json(await serialize(await pipeline.get(id)));
  });

  /** A person dismisses one of the findings the last Verify reported, while the card waits at awaiting_ship. */
  app.post("/tasks/:id/findings/:findingId/dismiss", async (c) => {
    const id = taskId(c);
    const { reason } = await body(c, DismissFindingInput);
    await pipeline.dismissFinding(id, c.req.param("findingId").slice(0, 200), reason);
    return c.json(await serialize(await pipeline.get(id)));
  });

  /** A person waives one design finding at the design sign-off, with a kind and a reason (RFC 0013): not at any other gate (409), not a finding the gate does not hold (404). */
  app.post("/tasks/:id/design/findings/:findingId/waive", async (c) => {
    const id = taskId(c);
    const input = await body(c, WaiveDesignFindingInput);
    await pipeline.waiveDesignFinding(id, c.req.param("findingId").slice(0, 200), input);
    return c.json(await serialize(await pipeline.get(id)));
  });

  /** A person adds a finding Verify missed. */
  app.post("/tasks/:id/findings", async (c) => {
    const id = taskId(c);
    await pipeline.addFinding(id, await body(c, AddFindingInput));
    return c.json(await serialize(await pipeline.get(id)));
  });

  app.post("/tasks/:id/abort", async (c) => c.json(await serialize(await pipeline.abort(taskId(c)))));

  /** Re-runs the stage a task paused in after a usage limit. */
  app.post("/tasks/:id/resume", async (c) => c.json(await serialize(await pipeline.windowReset(taskId(c)))));

  /** Removes the task's worktree from disk; the task and its branch stay. */
  app.post("/tasks/:id/worktree/remove", async (c) => c.json(await serialize(await pipeline.removeWorktree(taskId(c), { discard: c.req.query("discard") === "true" }))));
  return app;
}
