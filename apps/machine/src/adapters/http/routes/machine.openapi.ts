// OpenAPI route definitions of the machine's own routes (workbench's `<area>.openapi.ts`): each route's
// request and every response it can give, in zod, so `GET /openapi.json` describes them and the router
// validates them. Response schemas are held to the contracts' types with `expectSame`.
import {
  AgentRole, EngineId, ForemanAction, type EngineInfo, type ForemanSuggestion, type Metrics, METRICS_GROUP_BY, type PackInfo, PackId, RunInput, type RunResult, StubPlanInput, TaskState,
  MachinePolicySchema, TicketChatAnswer, type Slots,
} from "@hardness/contracts";
import { createRoute, z } from "@hono/zod-openapi";

import { ForemanInput, TicketChatInput } from "./kit.ts";
import { errorResponses, expectSame, jsonBody, jsonContent, type Same } from "../openapi/schemas.ts";

const TAGS = ["Machine"];
const METRICS_TAGS = ["Metrics"];

export const SlotsSchema = z
  .object({
    max: z.number().int().openapi({ example: 4 }),
    active: z.number().int().openapi({ example: 1 }),
    draining: z.boolean(),
    latched: z.array(z.object({ owner: z.enum(["claude", "codex", "openai", "typesafe"]), until: z.string() })).optional(),
  })
  .openapi("Slots");
expectSame<Same<z.infer<typeof SlotsSchema>, Slots>>();

const policy = { sandboxPolicy: MachinePolicySchema.optional(), notInForce: z.array(z.string()).optional() };

export const healthRoute = createRoute({
  operationId: "getHealth",
  method: "get",
  path: "/health",
  tags: TAGS,
  summary: "Whether the machine can do its job",
  description: "200 when nothing keeps the machine from working; 503 with the problems (no GitHub token, no git identity, stub stages), so the compose healthcheck and `up --wait` fail visibly. The stage pool and the sandbox policy in force are in both.",
  responses: {
    200: jsonContent(z.object({ ok: z.literal(true), slots: SlotsSchema, ...policy }), "The machine can work"),
    503: jsonContent(z.object({ ok: z.literal(false), problems: z.array(z.string()), slots: SlotsSchema, ...policy }), "What keeps the machine from working"),
    ...errorResponses(),
  },
});

export const SlotsInput = z.object({ max: z.number().int().min(1).openapi({ example: 4, description: "How many stages may run at once" }) });

export const setSlotsRoute = createRoute({
  operationId: "setSlots",
  method: "patch",
  path: "/slots",
  tags: TAGS,
  summary: "Set how many stages run at once",
  request: jsonBody(SlotsInput),
  responses: {
    200: jsonContent(SlotsSchema, "The stage pool after the change"),
    ...errorResponses(400),
  },
});

// --- Packs and engines ---------------------------------------------------------------------------

export const PackInfoSchema = z
  .object({
    id: PackId,
    agent: AgentRole.nullable(),
    kind: z.enum(["agent", "decision", "script"]),
    engines: z.object({ default: EngineId, allowed: z.array(EngineId), fallback: z.array(EngineId).optional() }),
    effort: z.enum(["low", "medium", "high"]).nullable(),
    writable: z.boolean(),
    maxTurns: z.number(),
    timeoutMs: z.number(),
    states: z.array(TaskState),
  })
  .openapi("PackInfo");
expectSame<Same<z.infer<typeof PackInfoSchema>, PackInfo>>();

export const packsRoute = createRoute({
  operationId: "listPacks",
  method: "get",
  path: "/packs",
  tags: TAGS,
  summary: "Every pack in the registry",
  description: "One row per pack, with the engines it may run on, its limits and the task states it runs in (none for the inboxes' packs).",
  responses: { 200: jsonContent(z.array(PackInfoSchema), "The packs"), ...errorResponses() },
});

export const EngineInfoSchema = z
  .object({
    id: EngineId,
    runtime: z.enum(["claude", "eve", "jev"]),
    modelId: z.string().openapi({ description: "The pinned ID the runtime passes to its SDK" }),
    auth: z.enum(["subscription", "chatgpt", "api-key"]),
    status: z.enum(["preview", "ga", "deprecated"]),
    available: z.boolean().openapi({ description: "This machine has the credential the engine needs" }),
    reason: z.string().optional(),
    spentThisMonthUsd: z.number(),
    budgetUsd: z.number().nullable(),
  })
  .openapi("EngineInfo");
expectSame<Same<z.infer<typeof EngineInfoSchema>, EngineInfo>>();

export const enginesRoute = createRoute({
  operationId: "listEngines",
  method: "get",
  path: "/engines",
  tags: TAGS,
  summary: "Every engine and whether this machine can run it",
  description: "The catalog's facts per engine, whether the credential it needs is present (never the credential), and this month's spend against its cap.",
  responses: { 200: jsonContent(z.array(EngineInfoSchema), "The engines"), ...errorResponses() },
});

// --- Runs ----------------------------------------------------------------------------------------

const TokensSchema = z
  .object({ input: z.number(), output: z.number(), cached: z.number(), cacheWrite5m: z.number().optional(), cacheWrite1h: z.number().optional() })
  .openapi("Tokens");

export const RunResultSchema = z
  .object({
    answer: z.record(z.string(), z.unknown()).openapi({ description: "The pack's answer, validated against its schema (open: each pack has its own)" }),
    usage: z.object({ model: z.string(), engine: EngineId, turns: z.number(), durationMs: z.number(), costUsd: z.number().nullable(), tokens: TokensSchema.nullable().optional() }),
    recordId: z.string().optional(),
  })
  .openapi("RunResult");
expectSame<Same<z.infer<typeof RunResultSchema>, RunResult>>();

export const runsRoute = createRoute({
  operationId: "runPack",
  method: "post",
  path: "/runs",
  tags: TAGS,
  summary: "Run one context-only pack on data the client sends",
  description: "The pack's validated answer and what it cost. `X-Luna-Client` names the caller for its record. Packs that have their own route (`ticket_chat`, `design_spec`, `a11y_audit`) are refused with 400.",
  request: { ...jsonBody(RunInput), headers: z.object({ "x-luna-client": z.string().optional().openapi({ description: "Who calls (1 to 64 letters, digits, dots, dashes or underscores)" }) }) },
  responses: {
    200: jsonContent(RunResultSchema, "The pack's answer and its usage"),
    ...errorResponses(400, 409, 422, 429, 499, 503),
  },
});

// --- Foreman -------------------------------------------------------------------------------------

export const ForemanSuggestionSchema = z.intersection(ForemanAction, z.object({ approvalId: z.string().nullable() })).openapi("ForemanSuggestion");
expectSame<Same<z.infer<typeof ForemanSuggestionSchema>, ForemanSuggestion>>();

export const ForemanReplySchema = z
  .object({
    reply: z.string(),
    actions: z.array(ForemanSuggestionSchema),
    dropped: z.array(z.object({ action: ForemanAction, problem: z.string() })),
  })
  .openapi("ForemanReply");

export const foremanRoute = createRoute({
  operationId: "askForeman",
  method: "post",
  path: "/foreman",
  tags: TAGS,
  summary: "Ask the foreman about the open board",
  description: "One question on the open board, answered with a reply and actions the board can take. It only suggests; the board makes each call after a person's confirmation. `dropped` holds the suggestions the board cannot take, with why.",
  request: jsonBody(ForemanInput),
  responses: {
    200: jsonContent(ForemanReplySchema, "The reply and the suggested actions"),
    ...errorResponses(400, 409, 422, 429, 499, 502, 503),
  },
});

// --- Ticket chat ---------------------------------------------------------------------------------

export const ticketChatRoute = createRoute({
  operationId: "ticketChat",
  method: "post",
  path: "/ticket-chat",
  tags: TAGS,
  summary: "One turn of the ticket planner",
  description: "One turn of a talk about a ticket, reading a throwaway copy of the repo's tracked files. It only drafts; the board creates the card. `repo` must be an absolute path of a repo the machine knows.",
  request: jsonBody(TicketChatInput),
  responses: {
    200: jsonContent(TicketChatAnswer, "The planner's reply, choices, notes and draft"),
    ...errorResponses(400, 404, 409, 422, 429, 499, 502, 503),
  },
});

// --- Slot knobs ----------------------------------------------------------------------------------

export const drainRoute = createRoute({
  operationId: "drain",
  method: "post",
  path: "/drain",
  tags: TAGS,
  summary: "Stop picking up work",
  responses: { 200: jsonContent(SlotsSchema, "The stage pool, draining"), ...errorResponses() },
});

export const resumeRoute = createRoute({
  operationId: "resumeClaims",
  method: "post",
  path: "/resume",
  tags: TAGS,
  summary: "Carry on picking up work",
  responses: { 200: jsonContent(SlotsSchema, "The stage pool, no longer draining"), ...errorResponses() },
});

// --- Metrics -------------------------------------------------------------------------------------

const StatsSchema = z.object({ median: z.number().nullable(), p90: z.number().nullable() });
const FlowCountSchema = z.object({ value: z.number().nullable(), n: z.number() });
const FlowStatsSchema = StatsSchema.extend({ n: z.number() });
const TaskCountsSchema = z.object({ created: z.number(), closed: z.number(), open: z.number(), waitingOnYou: z.number(), running: z.number(), queued: z.number() });

export const MetricsSchema = z
  .object({
    since: z.string(),
    until: z.string(),
    repo: z.string().nullable().optional(),
    byRepo: z.array(z.object({ repo: z.string().nullable(), tasks: TaskCountsSchema, escalationRate: z.number().nullable(), firstPassVerifying: z.number().nullable(), costUsd: z.number() })).optional(),
    byEngine: z
      .array(
        z.object({
          engine: EngineId.nullable(),
          stageRuns: z.number(),
          firstPassRate: z.number().nullable(),
          escalations: z.number(),
          rateLimited: z.number(),
          meanTurns: z.number().nullable(),
          meanDurationMs: z.number().nullable(),
          costUsd: z.number(),
        }),
      )
      .optional(),
    byFingerprint: z.array(z.object({ fingerprint: z.string().nullable(), runs: z.number(), passRate: z.number().nullable(), costUsd: z.number(), durationMs: StatsSchema, stages: z.array(z.string()), engines: z.array(z.string()) })).optional(),
    tasks: TaskCountsSchema,
    cycleTimeMs: z.object({ task: StatsSchema, perStage: z.record(z.string(), StatsSchema.extend({ runs: z.number() })) }),
    gates: z.object({ withinSla: z.number().nullable(), answered: z.number(), waitMs: z.record(z.string(), StatsSchema) }),
    flow: z
      .object({
        planCycleMs: FlowStatsSchema,
        coverageRounds: FlowCountSchema,
        buildRuns: FlowCountSchema,
        leadTimeMs: FlowStatsSchema,
        mergesPerWeek: FlowCountSchema,
        changeFailureRate: FlowCountSchema.extend({ reason: z.string() }),
        timeToRestoreMs: FlowCountSchema.extend({ reason: z.string() }),
      })
      .optional(),
    economy: z
      .object({
        effective: z.object({ exec: z.number(), overhead: z.number() }),
        overheadShare: z.number(),
        overheadUnpriced: z.number(),
        guard: z.object({ redirects: z.number(), stops: z.number() }),
        facts: z.object({ active: z.number(), promoted: z.number() }),
        masked: z.number(),
      })
      .optional(),
    firstPassRate: z.object({ verifying: z.number().nullable(), ci_watch: z.number().nullable(), implementing: z.number().nullable() }),
    escalations: z.object({ rate: z.number().nullable(), topReasons: z.array(z.object({ reason: z.string(), count: z.number() })) }),
    retries: z.object({ perTask: StatsSchema, byLoop: z.object({ verify: z.number(), e2e: z.number(), ci: z.number() }) }),
    cost: z.object({ totalUsd: z.number(), perTaskUsd: StatsSchema, byStage: z.record(z.string(), z.number()) }),
    queue: z.object({ depth: z.number(), slots: SlotsSchema, utilisation: z.number().nullable() }),
    budget: z.object({ taskUsd: z.number().nullable(), dailyUsd: z.number().nullable(), spentTodayUsd: z.number(), remainingTodayUsd: z.number().nullable() }),
  })
  .openapi("Metrics");
expectSame<Same<z.infer<typeof MetricsSchema>, Metrics>>();

export const metricsRoute = createRoute({
  operationId: "getMetrics",
  method: "get",
  path: "/metrics",
  tags: METRICS_TAGS,
  summary: "The machine's numbers over a window",
  description: "Throughput, cycle times, first-pass rates, escalations, cost, queue and budget. Numbers with no data are null, never NaN. `groupBy` adds a row per repo, engine or fingerprint; `repo` limits the numbers to one repository (empty: tasks with no repository).",
  request: {
    query: z.object({
      since: z.string().optional().openapi({ description: "`7d`, `30d` or an ISO date", example: "7d" }),
      groupBy: z.string().optional().openapi({ description: `One of ${METRICS_GROUP_BY.join(", ")}` }),
      repo: z.string().optional().openapi({ description: "A repository's path; empty for tasks with no repository" }),
    }),
  },
  responses: { 200: jsonContent(MetricsSchema, "The metrics"), ...errorResponses(400) },
});

// --- Dev stubs -----------------------------------------------------------------------------------

export const devStubsRoute = createRoute({
  operationId: "planDevStubs",
  method: "post",
  path: "/dev/stubs",
  tags: TAGS,
  summary: "Queue results for a stub stage (dev only)",
  description: "Only served when the machine runs stub stages: queues results for a stage, e.g. three failures for `verifying`.",
  request: jsonBody(StubPlanInput),
  responses: { 200: jsonContent(z.object({ stage: z.string(), queued: z.number() }), "How many results are queued"), ...errorResponses(400) },
});
