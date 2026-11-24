// OpenAPI route definitions of the tasks (the cards): the list, the work order, the detail, the edits, the gates and the actions.
// Every response a route can give is in zod; the shapes the contracts keep as interfaces are held to them with `expectSame`.
import {
  AddFindingInput, AnswersInput, ArchiveInput, ArtifactKind, type Approval, type Artifact, type BuildProgress, CardEventName, ContextInput, DecisionInput, DedupAnswerInput, DismissFindingInput,
  EditCasesInput, EditPlanInput, EditRecordInput, EditStagesInput, EngineId, EscalationReasonInput, EvidenceFeedbackInput, MergeCardInput, NewTaskInput, type ShipView, type StageRun, type TaskDetail,
  type TaskDiff, type TaskDiffFile, type TaskEvent, TaskReports, TaskState, UpdateTaskInput, WaiveDesignFindingInput,
} from "@hardness/contracts";
import { createRoute, z } from "@hono/zod-openapi";

import { errorResponses, expectSame, jsonBody, jsonContent, type Same, TaskIdParams } from "../openapi/schemas.ts";
import { TaskSchema } from "../openapi/task.schema.ts";

const TAGS = ["Tasks"];

export const StageRunSchema = z
  .object({
    id: z.string(),
    stage: TaskState,
    attempt: z.number().int(),
    status: z.enum(["running", "passed", "failed", "paused", "aborted"]),
    outcome: z.string().nullable(),
    costUsd: z.number().nullable(),
    turns: z.number().nullable(),
    cases: z.array(z.object({ title: z.string(), ok: z.boolean() })).nullable(),
    engine: EngineId.nullable(),
    runtime: z.string().nullable(),
    modelId: z.string().nullable(),
    sdkVersion: z.string().nullable(),
    fingerprint: z.string().nullable(),
    startedAt: z.string(),
    endedAt: z.string().nullable(),
  })
  .openapi("StageRun");
expectSame<Same<z.infer<typeof StageRunSchema>, StageRun>>();

export const ApprovalSchema = z
  .object({
    id: z.string(),
    kind: TaskState,
    requested: z.record(z.string(), z.unknown()),
    decision: z.enum(["approved", "sent_back", "rejected", "answered"]).nullable(),
    reason: z.string().nullable(),
    response: z.record(z.string(), z.unknown()).nullable(),
    createdAt: z.string(),
    decidedAt: z.string().nullable(),
  })
  .openapi("Approval");
expectSame<Same<z.infer<typeof ApprovalSchema>, Approval>>();

export const TaskEventSchema = z
  .object({
    id: z.string(),
    taskId: z.string(),
    kind: z.string(),
    payload: z.record(z.string(), z.unknown()),
    at: z.string(),
    names: z.array(CardEventName).optional(),
  })
  .openapi("TaskEvent");
expectSame<Same<z.infer<typeof TaskEventSchema>, TaskEvent>>();

export const ArtifactSchema = z
  .object({ id: z.string(), stageRunId: z.string(), kind: ArtifactKind, path: z.string(), label: z.string(), sha256: z.string(), createdAt: z.string() })
  .openapi("Artifact");
expectSame<Same<z.infer<typeof ArtifactSchema>, Artifact>>();

export const BuildProgressSchema = z
  .object({
    scenarios: z.array(z.object({ id: z.string(), state: z.enum(["red", "green"]) })),
    budget: z.object({
      iterations: z.number(),
      tokens: z.number().nullable(),
      minutes: z.number(),
      limits: z.object({ max_iterations: z.number(), max_tokens: z.number(), max_minutes: z.number() }),
    }),
    lastCheckpoint: z.object({ sha: z.string(), follows: z.enum(["red", "green"]), at: z.string() }).nullable(),
    slices: z.array(z.object({ slice: z.number(), owner: z.enum(["implementer", "ui-designer"]), picked: z.array(z.string()).optional() })).optional(),
    helper: z
      .object({
        slice: z.number(),
        state: z.enum(["running", "returned", "conflict_rerun", "committed", "refused", "failed", "cancelled", "merge_conflict"]),
        attempt: z.number(),
        branch: z.string(),
        startedAt: z.string(),
      })
      .nullable()
      .optional(),
  })
  .openapi("BuildProgress");
expectSame<Same<z.infer<typeof BuildProgressSchema>, BuildProgress>>();

export const ShipViewSchema = z
  .object({
    pr: z.object({ slug: z.string(), number: z.number(), url: z.string() }),
    head: z.string().nullable(),
    ready: z.boolean(),
    checklist: z.array(z.object({ id: z.string(), ok: z.boolean(), detail: z.string() })),
    autoMerge: z.object({ allowed: z.boolean(), reason: z.string() }),
    review: z.object({ required: z.boolean().nullable(), by: z.string().nullable() }),
    fixRounds: z.number(),
    queued: z.boolean(),
    quietSince: z.string().nullable(),
    lastEvent: z.object({ class: z.string(), at: z.string() }).nullable(),
    at: z.string().nullable(),
  })
  .openapi("ShipView");
expectSame<Same<z.infer<typeof ShipViewSchema>, ShipView>>();

export const TaskDetailSchema = z
  .object({
    task: TaskSchema,
    stageRuns: z.array(StageRunSchema),
    approvals: z.array(ApprovalSchema),
    events: z.array(TaskEventSchema).openapi({ description: "The latest 50 entries of the activity log" }),
    artifacts: z.array(ArtifactSchema),
    reports: TaskReports.optional(),
    buildProgress: BuildProgressSchema.nullable().optional(),
    ship: ShipViewSchema.nullable().optional(),
  })
  .openapi("TaskDetail");
expectSame<Same<z.infer<typeof TaskDetailSchema>, TaskDetail>>();

export const TaskDiffFileSchema = z
  .object({ path: z.string(), status: z.enum(["A", "M", "D", "R"]), added: z.number(), removed: z.number() })
  .openapi("TaskDiffFile");
expectSame<Same<z.infer<typeof TaskDiffFileSchema>, TaskDiffFile>>();

export const TaskDiffSchema = z
  .object({
    base: z.string(),
    head: z.string(),
    files: z.array(TaskDiffFileSchema),
    patch: z.string().optional(),
    truncated: z.boolean().optional(),
  })
  .openapi("TaskDiff");
expectSame<Same<z.infer<typeof TaskDiffSchema>, TaskDiff>>();

/** `POST /tasks/:id/questions/post`: the task, and whether this tap posted the comment (false when the same questions were already posted). */
export const PostedTaskSchema = TaskSchema.extend({ posted: z.boolean() }).openapi("PostedTask");

const FindingParams = TaskIdParams.extend({
  findingId: z.string().openapi({ param: { name: "findingId", in: "path" }, description: "The finding's id (cut to 200 characters)" }),
});

const taskResponse = (description: string) => jsonContent(TaskSchema, description);
/** What a route that changes a card can refuse: a bad body, an unknown card, a card not in a state that allows it. */
const changes = errorResponses(400, 404, 409);

export const listTasksRoute = createRoute({
  method: "get",
  path: "/tasks",
  tags: TAGS,
  summary: "Every task",
  description: "Every card, with its usage, clocks and glance.",
  responses: { 200: jsonContent(z.array(TaskSchema), "The tasks"), ...errorResponses() },
});

export const createTaskRoute = createRoute({
  method: "post",
  path: "/tasks",
  tags: TAGS,
  summary: "Create a work order",
  description: "With an `Idempotency-Key`, a retry answers the task already made (200); `start` starts it too. The same key with another body is 409 `idempotency_conflict`.",
  request: {
    ...jsonBody(NewTaskInput),
    headers: z.object({
      "idempotency-key": z.string().optional().openapi({ description: "The Idempotency-Key header, 1 to 200 characters; a retry with the same key answers the task made the first time" }),
    }),
  },
  responses: {
    201: taskResponse("The task was created"),
    200: taskResponse("An `Idempotency-Key` retry: the task made the first time"),
    ...errorResponses(400, 409),
  },
});

export const getTaskRoute = createRoute({
  method: "get",
  path: "/tasks/{id}",
  tags: TAGS,
  summary: "One task in full",
  description: "The task with its stage runs, approvals, latest events, artifacts, Build and Verify reports, build progress and the watched PR's checklist.",
  request: { params: TaskIdParams },
  responses: { 200: jsonContent(TaskDetailSchema, "The task and what it did"), ...errorResponses(404) },
});

export const updateTaskRoute = createRoute({
  method: "patch",
  path: "/tasks/{id}",
  tags: TAGS,
  summary: "Edit a task",
  request: { params: TaskIdParams, ...jsonBody(UpdateTaskInput) },
  responses: { 200: taskResponse("The task after the edit"), ...changes },
});

export const editPlanRoute = createRoute({
  method: "patch",
  path: "/tasks/{id}/plan",
  tags: TAGS,
  summary: "Edit the plan",
  description: "Changes the plan while it waits for approval (409 `no_plan` when the card has none open, `plan_approved` after).",
  request: { params: TaskIdParams, ...jsonBody(EditPlanInput) },
  responses: { 200: taskResponse("The task after the edit"), ...changes },
});

export const editRecordRoute = createRoute({
  method: "patch",
  path: "/tasks/{id}/record",
  tags: TAGS,
  summary: "Correct the Triage Record",
  description: "A person's correction of the Triage Record while the card waits at a gate: enum values only.",
  request: { params: TaskIdParams, ...jsonBody(EditRecordInput) },
  responses: { 200: taskResponse("The task after the edit"), ...changes },
});

export const postQuestionsRoute = createRoute({
  method: "post",
  path: "/tasks/{id}/questions/post",
  tags: TAGS,
  summary: "Post the open questions",
  description: "A person's tap: post the open questions where the card came from. Idempotent. 409 `no_questions` when the card is not waiting for answers, `secret` when a question carries a token.",
  request: { params: TaskIdParams },
  responses: { 200: jsonContent(PostedTaskSchema, "The task, and whether this call posted the comment"), ...changes },
});

export const editCasesRoute = createRoute({
  method: "patch",
  path: "/tasks/{id}/cases",
  tags: TAGS,
  summary: "Edit the test cases",
  description: "Replaces test_design's cases while the test check is open (409 `no_cases` otherwise).",
  request: { params: TaskIdParams, ...jsonBody(EditCasesInput) },
  responses: { 200: taskResponse("The task after the edit"), ...changes },
});

export const editStagesRoute = createRoute({
  method: "patch",
  path: "/tasks/{id}/stages",
  tags: TAGS,
  summary: "Change a pack's engine",
  description: "Changes the engine a pack runs on for this task, until that pack's stage starts (409 `stage_started` after).",
  request: { params: TaskIdParams, ...jsonBody(EditStagesInput) },
  responses: { 200: taskResponse("The task after the change"), ...changes },
});

export const taskDiffRoute = createRoute({
  method: "get",
  path: "/tasks/{id}/diff",
  tags: TAGS,
  summary: "The branch against its base",
  description: "One row per file; `?file=<path>` adds that file's patch (404 `no_file` unless the path is one of the rows, `no_worktree` when the task has none).",
  request: { params: TaskIdParams, query: z.object({ file: z.string().optional().openapi({ description: "A path from `files`: adds its patch" }) }) },
  responses: { 200: jsonContent(TaskDiffSchema, "The diff"), ...errorResponses(404) },
});

export const deleteTaskRoute = createRoute({
  method: "delete",
  path: "/tasks/{id}",
  tags: TAGS,
  summary: "Delete a task",
  request: { params: TaskIdParams },
  responses: { 204: { description: "The task is gone" }, ...errorResponses(404, 409) },
});

export const startTaskRoute = createRoute({
  method: "post",
  path: "/tasks/{id}/start",
  tags: TAGS,
  summary: "Start a draft",
  request: { params: TaskIdParams },
  responses: { 200: taskResponse("The task, started"), ...changes },
});

export const answersRoute = createRoute({
  method: "post",
  path: "/tasks/{id}/answers",
  tags: TAGS,
  summary: "Answer the open questions",
  request: { params: TaskIdParams, ...jsonBody(AnswersInput) },
  responses: { 200: taskResponse("The task after the answers"), ...changes },
});

export const decisionRoute = createRoute({
  method: "post",
  path: "/tasks/{id}/decision",
  tags: TAGS,
  summary: "Decide the gate",
  description: "Approves or sends back whatever the task is waiting on, including an escalation.",
  request: { params: TaskIdParams, ...jsonBody(DecisionInput) },
  responses: { 200: taskResponse("The task after the decision"), ...changes },
});

export const escalationReasonRoute = createRoute({
  method: "post",
  path: "/tasks/{id}/escalation-reason",
  tags: TAGS,
  summary: "Correct an escalation's reason",
  description: "Corrects the reason an escalation was decided with (the enum only); the card stays at its escalated gate.",
  request: { params: TaskIdParams, ...jsonBody(EscalationReasonInput) },
  responses: { 200: taskResponse("The task after the correction"), ...changes },
});

export const archiveRoute = createRoute({
  method: "post",
  path: "/tasks/{id}/archive",
  tags: TAGS,
  summary: "Archive a task",
  description: "Ends the task as archived with a reason (duplicate, sla_expired, rejected, not_for_agent, pr_closed).",
  request: { params: TaskIdParams, ...jsonBody(ArchiveInput) },
  responses: { 200: taskResponse("The task, archived"), ...changes },
});

export const contextRoute = createRoute({
  method: "post",
  path: "/tasks/{id}/context",
  tags: TAGS,
  summary: "Answer Intake's context gate",
  description: "A person picks the repository or project, or adds text; the card goes back through the check.",
  request: { params: TaskIdParams, ...jsonBody(ContextInput) },
  responses: { 200: taskResponse("The task after the context"), ...changes },
});

export const dedupRoute = createRoute({
  method: "post",
  path: "/tasks/{id}/dedup",
  tags: TAGS,
  summary: "Answer Intake's dedup gate",
  description: "\"Duplicate of one\", \"related to some\" or \"neither\".",
  request: { params: TaskIdParams, ...jsonBody(DedupAnswerInput) },
  responses: { 200: taskResponse("The task after the answer"), ...changes },
});

export const mergeRoute = createRoute({
  method: "post",
  path: "/tasks/{id}/merge",
  tags: TAGS,
  summary: "Merge a duplicate into another card",
  description: "A person marks the task as a duplicate of another card: its report merges into it.",
  request: { params: TaskIdParams, ...jsonBody(MergeCardInput) },
  responses: { 200: taskResponse("The task, merged"), ...changes },
});

export const unmergeRoute = createRoute({
  method: "post",
  path: "/tasks/{id}/unmerge",
  tags: TAGS,
  summary: "Undo a merge",
  description: "The duplicate comes back as a new card.",
  request: { params: TaskIdParams },
  responses: { 200: taskResponse("The task, unmerged"), ...changes },
});

export const evidenceFeedbackRoute = createRoute({
  method: "post",
  path: "/tasks/{id}/evidence/feedback",
  tags: TAGS,
  summary: "Rate the Evidence Pack",
  description: "A person's thumbs on the card's Evidence Pack: useful or not, with a short note. A card with no pack is a 409 (`no_evidence`).",
  request: { params: TaskIdParams, ...jsonBody(EvidenceFeedbackInput) },
  responses: { 200: taskResponse("The task"), ...changes },
});

export const dismissFindingRoute = createRoute({
  method: "post",
  path: "/tasks/{id}/findings/{findingId}/dismiss",
  tags: TAGS,
  summary: "Dismiss a finding",
  description: "A person dismisses one of the findings the last Verify reported, while the card waits at awaiting_ship.",
  request: { params: FindingParams, ...jsonBody(DismissFindingInput) },
  responses: { 200: taskResponse("The task"), ...changes },
});

export const waiveDesignFindingRoute = createRoute({
  method: "post",
  path: "/tasks/{id}/design/findings/{findingId}/waive",
  tags: TAGS,
  summary: "Waive a design finding",
  description: "A person waives one design finding at the design sign-off, with a kind and a reason: not at any other gate (409), not a finding the gate does not hold (404).",
  request: { params: FindingParams, ...jsonBody(WaiveDesignFindingInput) },
  responses: { 200: taskResponse("The task"), ...changes },
});

export const addFindingRoute = createRoute({
  method: "post",
  path: "/tasks/{id}/findings",
  tags: TAGS,
  summary: "Add a finding",
  description: "A person adds a finding Verify missed.",
  request: { params: TaskIdParams, ...jsonBody(AddFindingInput) },
  responses: { 200: taskResponse("The task"), ...changes },
});

export const abortRoute = createRoute({
  method: "post",
  path: "/tasks/{id}/abort",
  tags: TAGS,
  summary: "Abort the running stage",
  request: { params: TaskIdParams },
  responses: { 200: taskResponse("The task after the abort"), ...changes },
});

export const resumeRoute = createRoute({
  method: "post",
  path: "/tasks/{id}/resume",
  tags: TAGS,
  summary: "Resume a paused stage",
  description: "Re-runs the stage a task paused in after a usage limit.",
  request: { params: TaskIdParams },
  responses: { 200: taskResponse("The task, running again"), ...changes },
});

export const removeWorktreeRoute = createRoute({
  method: "post",
  path: "/tasks/{id}/worktree/remove",
  tags: TAGS,
  summary: "Remove the worktree",
  description: "Removes the task's worktree from disk; the task and its branch stay. 409 `unpushed_commits` unless `?discard=true`.",
  request: { params: TaskIdParams, query: z.object({ discard: z.string().optional().openapi({ description: "`true` drops commits that were never pushed" }) }) },
  responses: { 200: taskResponse("The task, without its worktree"), ...changes },
});
