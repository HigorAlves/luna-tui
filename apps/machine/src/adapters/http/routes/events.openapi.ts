// OpenAPI definition of the live stream: `GET /events` is Server-Sent Events, so its 200 is `text/event-stream`, not JSON.
import type { BudgetAlert, StreamMessage, TaskShipped } from "@hardness/contracts";
import { createRoute, z } from "@hono/zod-openapi";

import { errorResponses, expectSame, type Same } from "../openapi/schemas.ts";
import { TaskSchema } from "../openapi/task.schema.ts";
import { PrActivitySchema, PrSnapshotSchema } from "./github.openapi.ts";
import { MetricsSchema } from "./machine.openapi.ts";
import { SlackSnapshotSchema } from "./slack.openapi.ts";
import { TaskEventSchema } from "./tasks.openapi.ts";

export const BudgetAlertSchema = z
  .object({
    scope: z.enum(["task", "repo", "day", "engine"]),
    taskId: z.string().nullable(),
    repo: z.string().nullable(),
    engine: z.string().optional(),
    pct: z.union([z.literal(80), z.literal(90), z.literal(100)]),
    spentUsd: z.number(),
    limitUsd: z.number(),
  })
  .openapi("BudgetAlert");
expectSame<Same<z.infer<typeof BudgetAlertSchema>, BudgetAlert>>();

export const TaskShippedSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    prUrl: z.string(),
    number: z.number().int(),
    mergedSha: z.string().nullable(),
    format: z.string().nullable(),
    howToVerify: z.string().nullable(),
    media: z.array(z.object({ kind: z.string(), label: z.string(), url: z.string() })),
    at: z.string(),
  })
  .openapi("TaskShipped");
expectSame<Same<z.infer<typeof TaskShippedSchema>, TaskShipped>>();

/** What each event's `data:` carries, keyed by `type` (the event's `event:` name). */
export const StreamMessageSchema = z
  .discriminatedUnion("type", [
    z.object({ type: z.literal("task.updated"), task: TaskSchema, seq: z.number().int() }),
    z.object({ type: z.literal("budget.alert"), alert: BudgetAlertSchema }),
    z.object({ type: z.literal("task.event"), event: TaskEventSchema }),
    z.object({ type: z.literal("task.deleted"), id: z.string(), seq: z.number().int() }),
    z.object({ type: z.literal("task.metrics"), metrics: MetricsSchema }),
    z.object({ type: z.literal("stage.started"), taskId: z.string(), label: z.string(), cwd: z.string(), container: z.string() }),
    z.object({ type: z.literal("task.closed"), id: z.string() }),
    z.object({ type: z.literal("github.prs"), snapshot: PrSnapshotSchema }),
    z.object({ type: z.literal("github.prs.all"), snapshot: PrSnapshotSchema }),
    z.object({ type: z.literal("github.activity"), activity: z.array(PrActivitySchema) }),
    z.object({ type: z.literal("slack.items"), snapshot: SlackSnapshotSchema }),
    z.object({ type: z.literal("task.shipped"), shipped: TaskShippedSchema }),
  ])
  .openapi("StreamMessage", { description: "One Server-Sent Event's `data:`, as JSON; the event's `event:` is its `type`. `ready` and `ping` events carry `{}` and are not StreamMessages." });
expectSame<Same<z.infer<typeof StreamMessageSchema>, StreamMessage>>();

export const eventsRoute = createRoute({
  operationId: "streamEvents",
  method: "get",
  path: "/events",
  tags: ["Events"],
  summary: "Live updates over Server-Sent Events",
  description:
    "A `text/event-stream`. Each event's `event:` is the message type and its `data:` the message as JSON (`StreamMessage`): `task.updated` (task, seq), `task.deleted` (id, seq), `task.event`, `task.metrics`, `task.closed`, `task.shipped`, `stage.started`, `budget.alert`, `github.prs`, `github.prs.all`, `slack.items`. " +
    "`ready` (data `{}`) follows the replay, and `ping` (data `{}`) every 15 seconds keeps the connection alive. " +
    "`since` replays the task changes past that sequence number first, `source` keeps one source's tasks, `names` keeps the cards' diagram events of those names.",
  request: {
    query: z.object({
      since: z.string().optional().openapi({ description: "A sequence number: replay the task changes after it first", example: "120" }),
      source: z.string().optional().openapi({ description: "Keep only the tasks of one source kind" }),
      names: z.string().optional().openapi({ description: "Comma-separated diagram event names to keep" }),
    }),
  },
  responses: {
    200: {
      description: "The event stream; it stays open until the client leaves",
      // Each frame is `event: <type>` and `data: <StreamMessage as JSON>`; the schema is the message, so a generated client gets its type.
      content: { "text/event-stream": { schema: StreamMessageSchema } },
    },
    ...errorResponses(400),
  },
});
