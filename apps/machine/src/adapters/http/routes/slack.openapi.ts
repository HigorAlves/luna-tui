// OpenAPI route definitions of the Slack inbox: each route's request and every response it can give, in zod.
// The response schemas are held to the contracts' types with `expectSame`.
import {
  ChannelKind,
  EngineId,
  SlackCategory,
  SlackItemKind,
  SlackItemPatch,
  SlackPriority,
  SlackRelationInput,
  SlackReplyInput,
  SlackSplit,
  SlackTaskInput,
  SlackWatchInput,
  SlackWatchKind,
  SlackWatchPatch,
  type Conversation,
  type SlackItem,
  type SlackMetrics,
  type SlackSnapshot,
  type SlackTriageRuns,
  type SlackWatch,
} from "@hardness/contracts";
import { createRoute, z } from "@hono/zod-openapi";

import type { SlackInboxPort } from "../../../application/slack-inbox.ts";
import { errorResponses, expectSame, jsonBody, jsonContent, type Same } from "../openapi/schemas.ts";
import { TaskSchema } from "../openapi/task.schema.ts";

const TAGS = ["Slack"];

// ── Shapes ──

const PrioritySchema = SlackPriority;
const ByPriority = <T extends z.ZodType>(schema: T) => z.object({ P0: schema, P1: schema, P2: schema, P3: schema });

const SlackUserSchema = z.object({ id: z.string(), name: z.string(), isBot: z.boolean() }).openapi("SlackUser");

export const SlackWatchSchema = z
  .object({
    id: z.string(),
    kind: SlackWatchKind,
    value: z.string().openapi({ description: "The usergroup id (`S…`), the broadcast (`here` | `channel` | `everyone`), the keyword, or the channel id" }),
    label: z.string().openapi({ example: "@platform-team" }),
    channels: z.array(z.string()).openapi({ description: "Channel ids a keyword is limited to; empty means everywhere" }),
    enabled: z.boolean(),
    builtin: z.boolean().openapi({ description: "The three broadcasts ship on and cannot be deleted, only switched off" }),
    priority: PrioritySchema.nullable().openapi({ description: "A floor for triage: an item matching this watch is at least this priority" }),
    createdAt: z.string(),
  })
  .openapi("SlackWatch");
expectSame<Same<z.infer<typeof SlackWatchSchema>, SlackWatch>>();

const SlackTriageSchema = z
  .object({
    priority: PrioritySchema,
    category: SlackCategory,
    expectsReply: z.boolean(),
    summary: z.string(),
    why: z.string(),
    draft: z.string().nullable(),
    refs: z.array(z.object({ kind: z.enum(["pr", "issue", "jira", "url"]), ref: z.string() })),
    deadline: z.string().nullable(),
    by: z.enum(["model", "rules"]),
    triagedAt: z.string(),
    overridden: z.boolean(),
  })
  .openapi("SlackTriage");

const CanonicalMessageSchema = z
  .object({
    id: z.string(),
    threadId: z.string(),
    platform: z.literal("slack"),
    channel: z.object({ id: z.string(), name: z.string(), kind: ChannelKind }),
    author: SlackUserSchema,
    text: z.string(),
    attachments: z.array(z.object({ id: z.string(), name: z.string(), kind: z.string() })),
    mentions: z.array(z.string()),
    permalink: z.string(),
    ts: z.string(),
    editedAt: z.string().nullable(),
    deleted: z.boolean(),
  })
  .openapi("CanonicalMessage");

const OtherSource = z.object({ kind: z.enum(["jira", "github"]), key: z.string() }).nullable();

const ConversationSchema = z
  .object({
    history: z.array(CanonicalMessageSchema),
    participants: z.array(SlackUserSchema),
    private: z.boolean(),
    repo: z.string().nullable(),
    classification: z
      .object({
        kind: z.string(),
        confidence: z.number(),
        by: z.enum(["model", "person"]),
        at: z.string(),
        records: z.record(z.string(), z.string()),
        verdict: z.enum(["ok", "ask"]).optional(),
        priority: z.string().optional(),
        total: z.number().optional(),
        knockOut: z.string().nullable().optional(),
        scores: z.record(z.string(), z.object({ score: z.number(), confidence: z.number() })).optional(),
      })
      .nullable(),
    relation: z
      .object({
        type: z.enum(["related_to_in_progress", "related_to_backlog", "new_candidate", "none", "ask"]),
        target: z.string().nullable(),
        confidence: z.number(),
        by: z.enum(["model", "person"]),
        at: z.string(),
        record: z.string().optional(),
        otherSource: OtherSource.optional(),
        applied: z.object({ at: z.string(), bumped: z.boolean(), backlog: z.string().optional() }).optional(),
      })
      .nullable(),
    shortlist: z
      .array(z.object({ slot: z.number(), id: z.string(), kind: z.enum(["open", "closed", "backlog"]), otherSource: OtherSource, title: z.string().optional() }))
      .optional(),
    redactions: z.number(),
    pii: z.array(z.enum(["email", "phone"])),
  })
  .openapi("Conversation");
expectSame<Same<z.infer<typeof ConversationSchema>, Conversation>>();

export const SlackItemSchema = z
  .object({
    id: z.string().openapi({ description: "`<channel id>:<message ts>`; for a collapsed thread, the parent's" }),
    kind: SlackItemKind,
    channel: z.object({ id: z.string(), name: z.string(), kind: ChannelKind }),
    author: SlackUserSchema,
    text: z.string(),
    threadTs: z.string().nullable(),
    context: z.array(z.object({ ts: z.string(), user: SlackUserSchema, text: z.string() })),
    permalink: z.string(),
    ts: z.string(),
    matched: z.array(z.string()).openapi({ description: "Why it is in your inbox: `me`, `usergroup:S…`, `broadcast:here`, `keyword:…`, `channel:C…`, `dm`, `thread`, `reaction`" }),
    count: z.number(),
    replies: z.number(),
    youReplied: z.boolean(),
    seenAt: z.string().nullable(),
    doneAt: z.string().nullable(),
    snoozedUntil: z.string().nullable(),
    reopenedAt: z.string().nullable(),
    dueAt: z.string().nullable(),
    overdue: z.boolean(),
    triage: SlackTriageSchema.nullable(),
    split: SlackSplit,
    linked: z.object({ pr: z.object({ repo: z.string(), number: z.number(), split: z.string() }).nullable(), taskId: z.string().nullable() }),
    draft: z
      .object({ id: z.string(), kind: z.enum(["reply", "questions", "shipped", "status"]), text: z.string(), hash: z.string().optional(), expiresAt: z.string() })
      .nullable()
      .optional(),
    conversation: ConversationSchema.nullable().optional(),
  })
  .openapi("SlackItem");
expectSame<Same<z.infer<typeof SlackItemSchema>, SlackItem>>();

export const SlackSnapshotSchema = z
  .object({
    items: z.array(SlackItemSchema),
    watches: z.array(SlackWatchSchema),
    me: SlackUserSchema.nullable(),
    polledAt: z.string().nullable(),
    error: z.string().nullable(),
    socket: z.enum(["connected", "disconnected", "off"]).openapi({ description: "The Socket Mode websocket: `off` without an app token" }),
    sla: ByPriority(z.number()).openapi({ description: "The reply SLA in effect, seconds by priority" }),
    quiet: z.boolean(),
    scope: z.enum(["opted_in", "all"]).optional(),
    optedIn: z.number().optional(),
  })
  .openapi("SlackSnapshot");
expectSame<Same<z.infer<typeof SlackSnapshotSchema>, SlackSnapshot>>();

const StatsSchema = z.object({ median: z.number().nullable(), p90: z.number().nullable() });

export const SlackMetricsSchema = z
  .object({
    since: z.string(),
    items: ByPriority(z.number()),
    replied: ByPriority(z.number()),
    withinHour: z.number(),
    withinSla: ByPriority(z.number()),
    sla: ByPriority(z.number()),
    timeToReply: ByPriority(StatsSchema),
    byDay: z.array(z.object({ day: z.string(), items: z.number(), replied: z.number() })),
  })
  .openapi("SlackMetrics");
expectSame<Same<z.infer<typeof SlackMetricsSchema>, SlackMetrics>>();

export const SlackTriageRunsSchema = z
  .object({
    since: z.string(),
    runs: z.array(
      z.object({
        id: z.string(),
        startedAt: z.string(),
        endedAt: z.string(),
        items: z.number(),
        model: z.string(),
        engine: EngineId.nullable().optional(),
        runtime: z.string().optional(),
        modelId: z.string().optional(),
        sdkVersion: z.string().optional(),
        fingerprint: z.string().optional(),
        turns: z.number(),
        costUsd: z.number().nullable(),
        ok: z.boolean(),
        error: z.string().nullable(),
      }),
    ),
    items: z.number(),
    costUsd: z.number(),
  })
  .openapi("SlackTriageRuns");
expectSame<Same<z.infer<typeof SlackTriageRunsSchema>, SlackTriageRuns>>();

const UsergroupsSchema = z.array(z.object({ id: z.string(), handle: z.string().openapi({ description: "Without the `@`" }), name: z.string() }).openapi("Usergroup"));
expectSame<Same<z.infer<typeof UsergroupsSchema>, Awaited<ReturnType<SlackInboxPort["usergroups"]>>>>();
const ChannelsSchema = z.array(z.object({ id: z.string(), name: z.string(), kind: ChannelKind }).openapi("SlackChannel"));
expectSame<Same<z.infer<typeof ChannelsSchema>, Awaited<ReturnType<SlackInboxPort["channels"]>>>>();

// ── Params and query ──

const ItemParams = z.object({
  id: z.string().openapi({ param: { name: "id", in: "path" }, example: "C0123ABCD:1731000000.000100", description: "The item's id, `<channel id>:<message ts>`" }),
});
const WatchParams = z.object({ id: z.string().openapi({ param: { name: "id", in: "path" }, description: "The watch's id" }) });
const SinceQuery = z.object({ since: z.string().optional().openapi({ param: { name: "since", in: "query" }, example: "7d", description: "`7d` or `30d`" }) });

// ── Routes ──

export const itemsRoute = createRoute({
  method: "get",
  path: "/slack/items",
  tags: TAGS,
  summary: "The Slack inbox",
  description: "The inbox as the machine last polled it: items with their `split` and `triage`, the watches, the reply SLA in effect and the socket's state.",
  responses: { 200: jsonContent(SlackSnapshotSchema, "The inbox"), ...errorResponses() },
});

export const refreshRoute = createRoute({
  method: "post",
  path: "/slack/refresh",
  tags: TAGS,
  summary: "Poll Slack now",
  responses: { 200: jsonContent(SlackSnapshotSchema, "The fresh snapshot"), ...errorResponses(409) },
});

export const patchItemRoute = createRoute({
  method: "patch",
  path: "/slack/items/{id}",
  tags: TAGS,
  summary: "Clear, reopen, snooze or re-prioritise an item",
  description: "`done: true` clears the item on our side (and in Slack when `MACHINE_SLACK_MARK_READ=on`), `false` reopens it; `snoozedUntil` is ISO or null; `priority` overrides triage and survives a re-triage; `kind` settles an `ask`.",
  request: { params: ItemParams, ...jsonBody(SlackItemPatch) },
  responses: { 200: jsonContent(SlackItemSchema, "The item"), ...errorResponses(400, 404, 409) },
});

export const relateItemRoute = createRoute({
  method: "post",
  path: "/slack/items/{id}/relation",
  tags: TAGS,
  summary: "Say what a thread is about",
  description: "`target` must be an id of the item's stored shortlist (`conversation.shortlist`), else 400; a stored answer, a bump or its undo and a truth record, never a post.",
  request: { params: ItemParams, ...jsonBody(SlackRelationInput) },
  responses: { 200: jsonContent(SlackItemSchema, "The item"), ...errorResponses(400, 404, 409) },
});

export const replyItemRoute = createRoute({
  method: "post",
  path: "/slack/items/{id}/reply",
  tags: TAGS,
  summary: "Reply in the item's thread as you",
  description: "Posts with your user token, clears the item and records the response time. 409 `no_token` without `MACHINE_SLACK_USER_TOKEN`; 409 `slack_refused` when the text carries something shaped like a secret or the draft is already being sent.",
  request: { params: ItemParams, ...jsonBody(SlackReplyInput) },
  responses: { 200: jsonContent(SlackItemSchema, "The item"), ...errorResponses(400, 404, 409) },
});

export const itemTaskRoute = createRoute({
  method: "post",
  path: "/slack/items/{id}/task",
  tags: TAGS,
  summary: "Make a Backlog task from an item",
  description: "A Backlog task from the message and its thread, `source.kind = slack`. 409 `already_task` when the item already became one.",
  request: { params: ItemParams, ...jsonBody(SlackTaskInput) },
  responses: { 201: jsonContent(TaskSchema, "The task"), ...errorResponses(400, 404, 409) },
});

export const watchesRoute = createRoute({
  method: "get",
  path: "/slack/watches",
  tags: TAGS,
  summary: "The watches",
  description: "The handles, broadcasts, keywords and channels the inbox treats as addressed to you. `@here`, `@channel` and `@everyone` are built in.",
  responses: { 200: jsonContent(z.array(SlackWatchSchema), "The watches"), ...errorResponses(409) },
});

export const addWatchRoute = createRoute({
  method: "post",
  path: "/slack/watches",
  tags: TAGS,
  summary: "Add a watch",
  description: "`value` is the usergroup id, the broadcast word, the keyword or the channel id; the label is resolved from Slack when absent.",
  request: jsonBody(SlackWatchInput),
  responses: { 201: jsonContent(SlackWatchSchema, "The watch"), ...errorResponses(400, 409) },
});

export const patchWatchRoute = createRoute({
  method: "patch",
  path: "/slack/watches/{id}",
  tags: TAGS,
  summary: "Change a watch",
  request: { params: WatchParams, ...jsonBody(SlackWatchPatch) },
  responses: { 200: jsonContent(SlackWatchSchema, "The watch"), ...errorResponses(400, 404) },
});

export const deleteWatchRoute = createRoute({
  method: "delete",
  path: "/slack/watches/{id}",
  tags: TAGS,
  summary: "Remove a watch",
  description: "409 `builtin` for the three broadcasts, which can only be switched off.",
  request: { params: WatchParams },
  responses: { 204: { description: "Removed" }, ...errorResponses(404, 409) },
});

export const metricsRoute = createRoute({
  method: "get",
  path: "/slack/metrics",
  tags: TAGS,
  summary: "How fast you answer",
  description: "Items and replies by priority, the share answered within an hour and inside the SLA, median and p90 seconds to reply, and a per-day series. `since` is `7d` or `30d`; anything else is 400.",
  request: { query: SinceQuery },
  responses: { 200: jsonContent(SlackMetricsSchema, "The metrics"), ...errorResponses(400) },
});

export const triageRunsRoute = createRoute({
  method: "get",
  path: "/slack/triage-runs",
  tags: TAGS,
  summary: "What triage cost",
  description: "One row per `slack_triage` pack run, newest first, with the items and dollars summed. `since` is `7d` or `30d`; anything else is 400.",
  request: { query: SinceQuery },
  responses: { 200: jsonContent(SlackTriageRunsSchema, "The runs"), ...errorResponses(400) },
});

export const usergroupsRoute = createRoute({
  method: "get",
  path: "/slack/usergroups",
  tags: TAGS,
  summary: "The workspace's usergroups",
  description: "From `usergroups.list`, cached ten minutes, for the watch popup's autocomplete.",
  responses: { 200: jsonContent(UsergroupsSchema, "The usergroups"), ...errorResponses(409) },
});

export const channelsRoute = createRoute({
  method: "get",
  path: "/slack/channels",
  tags: TAGS,
  summary: "The channels you are in",
  description: "Cached ten minutes.",
  responses: { 200: jsonContent(ChannelsSchema, "The channels"), ...errorResponses(409) },
});
