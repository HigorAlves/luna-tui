// The task (a card) as every route answers it (`serialize`, `toTask`): built from the contracts' own schemas,
// and held to the contracts' `Task` type at compile time, so the description cannot drift from the API.
import { ArchiveReason, CardAttachment, CardHints, CardSource, COLUMNS, EngineId, EvidencePack, OriginMachine, Reporter, StageEngines, type Task, TaskClassification, TaskRoute, TaskSource, TaskState, TriageRecord } from "@hardness/contracts";
import { z } from "@hono/zod-openapi";

import { expectSame, type Same } from "./schemas.ts";

const source = z.union([TaskSource, CardSource]);

export const RetriesSchema = z.object({
  verify: z.number().int(),
  e2e: z.number().int(),
  ci: z.number().int(),
  total: z.number().int(),
  stronger: z.number().int().optional(),
  strongerNext: z.boolean().optional(),
});

export const JiraLinkSchema = z
  .object({
    key: z.string().openapi({ example: "PLAT-123" }),
    url: z.string(),
    issueType: z.string().nullable(),
    status: z.string().nullable(),
    priority: z.string().nullable(),
    dueAt: z.string().nullable(),
    syncedAt: z.string().nullable(),
    blocked: z.object({ wanted: z.string(), current: z.string().nullable(), why: z.string(), at: z.string() }).nullable(),
    linkedAt: z.string().nullable().optional(),
    timeZone: z.string().nullable().optional(),
  })
  .openapi("JiraLink");

const SlaClockSchema = z.object({ dueAt: z.string(), overdue: z.boolean(), targetSecs: z.number() });
export const TaskSlaSchema = z
  .object({
    gate: SlaClockSchema.extend({ since: z.string(), state: TaskState }).nullable(),
    stage: SlaClockSchema.extend({ stage: TaskState, warn: z.boolean() }).nullable(),
    cycle: SlaClockSchema.nullable(),
    jiraDue: SlaClockSchema.nullable(),
  })
  .openapi("TaskSla");

export const TaskLastRunSchema = z.object({
  stage: TaskState,
  engine: EngineId.nullable(),
  outcome: z.string().nullable(),
  summary: z.string().nullable(),
  at: z.string(),
});

export const TaskGateSchema = z.object({
  id: z.string().optional(),
  state: TaskState,
  requested: z.record(z.string(), z.unknown()),
});

const ReviewLinksSchema = z.object({
  at: z.string(),
  jira: z.array(z.object({ key: z.string(), url: z.string(), summary: z.string(), how: z.enum(["key", "fact", "decision"]) })),
  cards: z.array(z.object({ id: z.string(), title: z.string(), how: z.enum(["fact", "decision"]), fact: z.string().optional() })),
  suggestion: z.object({ kind: z.enum(["jira", "card"]), id: z.string(), title: z.string(), confidence: z.number(), url: z.string().optional() }).optional(),
});

/** `CardFields`: what a card keeps of the entry contract. */
const CardFieldsShape = {
  sources: z.array(source),
  reporter: Reporter.nullable(),
  hints: CardHints.nullable(),
  originMachine: OriginMachine.nullable(),
  attachments: z.array(CardAttachment),
  project: z.string().nullable(),
  owners: z.array(z.string()),
  followers: z.array(z.string()),
  links: z.record(z.string(), z.string()),
  history: z.array(z.object({ author: z.string().nullable(), text: z.string(), at: z.string().nullable() })).optional(),
  demand: z.number().int().optional(),
  merged: z.array(z.object({ id: z.string(), sources: z.array(source).optional(), followers: z.array(z.string()).optional() })).optional(),
  dedup: z
    .object({
      at: z.string(),
      recordId: z.string().nullable(),
      candidates: z.array(z.object({ id: z.string(), kind: z.enum(["open", "closed", "backlog"]), score: z.number(), slot: z.number() })),
      answer: z.record(z.string(), z.object({ choice: z.string(), confidence: z.number() })).nullable(),
      outcome: z.enum(["duplicate", "related", "ask", "none", "skipped"]),
      chosen: z.enum(["duplicate", "related", "neither"]).optional(),
    })
    .optional(),
  splitFrom: z.string().optional(),
  audience: z.array(source).optional(),
  splitInto: z.array(z.string()).optional(),
  splitPart: z.object({ n: z.number().int(), of: z.number().int() }).optional(),
  dependsOn: z.array(z.string()).optional(),
  startWhenReady: z.boolean().optional(),
  riskFloor: z.enum(["low", "medium", "high"]).optional(),
  base: z.object({ card: z.string(), branch: z.string() }).optional(),
  related: z.array(z.string()).optional(),
  reviewLinks: ReviewLinksSchema.optional(),
  mergedInto: z.string().optional(),
  ticketChanged: z.object({ fields: z.array(z.string()), at: z.string() }).optional(),
  resolved: z.object({ repoPath: z.string().nullable(), project: z.string().nullable(), at: z.string() }).optional(),
};

export const TaskSchema = z
  .object({
    ...CardFieldsShape,
    id: z.string().openapi({ example: "b933eac0-7593-4564-ac9b-906df1577792" }),
    title: z.string().openapi({ example: "Cart totals show wrong price" }),
    description: z.string(),
    criteria: z.array(z.string()),
    repoPath: z.string().nullable(),
    source: TaskSource.nullable(),
    route: TaskRoute,
    branch: z.string().nullable(),
    worktreePath: z.string().nullable(),
    state: TaskState,
    column: z.enum(COLUMNS),
    waitingOnYou: z.boolean(),
    running: z.boolean(),
    queued: z.boolean(),
    retries: RetriesSchema,
    resumeTo: TaskState.nullable(),
    reason: z.string().nullable(),
    archiveReason: ArchiveReason.nullable(),
    spentUsd: z.number().nullable(),
    workedMs: z.number().nullable(),
    diff: z.object({ added: z.number().int(), removed: z.number().int() }).nullable(),
    tests: z.object({ passed: z.number().int(), total: z.number().int() }).nullable(),
    jira: JiraLinkSchema.nullable(),
    sla: TaskSlaSchema.nullable(),
    stages: StageEngines,
    classification: TaskClassification.nullable(),
    record: TriageRecord.nullable(),
    evidence: EvidencePack.nullable(),
    seq: z.number().int(),
    lastRun: TaskLastRunSchema.nullable(),
    gate: TaskGateSchema.nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("Task");
expectSame<Same<z.infer<typeof TaskSchema>, Task>>();
