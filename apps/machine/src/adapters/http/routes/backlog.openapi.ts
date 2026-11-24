// OpenAPI route definitions of the shared backlog. The routes exist only when the machine keeps a backlog.
import { BacklogAddInput, type BacklogEntry, BacklogScores, BacklogSize, CardSource, TaskSource } from "@hardness/contracts";
import { createRoute, z } from "@hono/zod-openapi";

import { errorResponses, expectSame, jsonBody, jsonContent, type Same } from "../openapi/schemas.ts";
import { TaskSchema } from "../openapi/task.schema.ts";

const TAGS = ["Backlog"];

export const BacklogEntrySchema = z
  .object({
    id: z.string(),
    title: z.string(),
    text: z.string(),
    sources: z.array(z.union([TaskSource, CardSource])),
    repo: z.string().nullable(),
    scores: BacklogScores,
    size: BacklogSize,
    demand: z.number(),
    dependsOn: z.array(z.string()),
    addedAt: z.string(),
    assessedAt: z.string(),
    score: z.number().openapi({ description: "Cost of delay over cost of doing" }),
    stale: z.boolean().openapi({ description: "Not assessed for `backlog.stale_days`" }),
    schedulable: z.boolean().optional(),
    blockedBy: z.array(z.object({ id: z.string(), kind: z.enum(["card", "item"]), state: z.string() })).optional(),
  })
  .openapi("BacklogEntry");
expectSame<Same<z.infer<typeof BacklogEntrySchema>, BacklogEntry>>();

/** `:id` of a backlog item. Any string reaches the handler: an id that is not a UUID cannot exist, so it is a 404, not a 400. */
const ItemParams = z.object({ id: z.string().openapi({ param: { name: "id", in: "path" }, description: "The item's id (a UUID)" }) });

export const listBacklogRoute = createRoute({
  operationId: "listBacklog",
  method: "get",
  path: "/backlog",
  tags: TAGS,
  summary: "The ranked backlog",
  description: "Each item with `score`, `stale`, `demand`, `size`, `scores`, `sources`, `dependsOn`, `schedulable` and `blockedBy`.",
  responses: { 200: jsonContent(z.array(BacklogEntrySchema), "The items, best first"), ...errorResponses() },
});

export const addBacklogRoute = createRoute({
  operationId: "addBacklogItem",
  method: "post",
  path: "/backlog",
  tags: TAGS,
  summary: "Add a candidate to the backlog",
  request: jsonBody(BacklogAddInput),
  responses: { 201: jsonContent(BacklogEntrySchema, "The item as ranked"), ...errorResponses(400) },
});

export const bumpBacklogRoute = createRoute({
  operationId: "bumpBacklogItem",
  method: "post",
  path: "/backlog/{id}/bump",
  tags: TAGS,
  summary: "Count one more report of an item",
  description: "Demand plus one, assessed now.",
  request: { params: ItemParams },
  responses: { 200: jsonContent(BacklogEntrySchema, "The item"), ...errorResponses(404) },
});

export const promoteBacklogRoute = createRoute({
  operationId: "promoteBacklogItem",
  method: "post",
  path: "/backlog/{id}/promote",
  tags: TAGS,
  summary: "Make a card of an item",
  description: "Makes a card of the item (`create_card`, its scores as hints) and removes it. 409 `not_schedulable` with `blockedBy` when the item waits for dependencies; nothing is removed.",
  request: { params: ItemParams },
  responses: { 201: jsonContent(TaskSchema, "The new card"), ...errorResponses(404, 409) },
});

export const declineBacklogRoute = createRoute({
  operationId: "declineBacklogItem",
  method: "post",
  path: "/backlog/{id}/decline",
  tags: TAGS,
  summary: "Remove an item from the backlog",
  request: { params: ItemParams },
  responses: { 200: jsonContent(z.object({ id: z.string() }), "The removed item's id"), ...errorResponses(404) },
});
