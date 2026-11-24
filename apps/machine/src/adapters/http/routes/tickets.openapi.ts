// OpenAPI route definitions of the Ticket Machine's taps. The routes exist only when the machine runs the ticket machine.
import { CanonicalTicket, SplitChild, TicketApproveInput, TicketEditInput, TicketIgnoreInput } from "@hardness/contracts";
import { createRoute, z } from "@hono/zod-openapi";

import type { Draft } from "../../../application/ticket-drafts.ts";
import type { DraftView, TicketMachine, TicketView } from "../../../application/ticket-machine.ts";
import { errorResponses, expectSame, jsonBody, jsonContent, type Same } from "../openapi/schemas.ts";

const TAGS = ["Tickets"];

export const DraftSchema = z
  .object({
    id: z.string(),
    ticket: z.string(),
    kind: z.enum(["assessment", "needs_info", "decline", "not_ours", "handover", "reminder", "park", "split"]),
    status: z.enum(["waiting", "edited", "ignored", "posting", "posted"]).openapi({ description: "`waiting` for a tap; `edited` is still waiting, with the person's text; `ignored` is kept and never posted" }),
    text: z.string(),
    original: z.string().optional().openapi({ description: "The machine's own text, kept beside an edit" }),
    history: z.array(z.object({ at: z.string(), did: z.enum(["edited", "ignored", "posted"]), from: z.string() })),
    children: z.array(SplitChild).optional().openapi({ description: "A split draft: the proposed children" }),
    created: z.array(z.object({ n: z.number(), key: z.string() })).optional().openapi({ description: "A split draft: the children the tap already made" }),
    rev: z.number().optional(),
  })
  .openapi("TicketDraftState");
expectSame<Same<z.infer<typeof DraftSchema>, Draft>>();

export const DraftViewSchema = DraftSchema.extend({ hash: z.string().openapi({ description: "What a tap names: the sha256 of the shown text (of the children for a split)" }) }).openapi("TicketDraftView");
expectSame<Same<z.infer<typeof DraftViewSchema>, DraftView>>();

/** The assessments and the clocks are the machine's own records, kept as written; their fields are not fixed. */
export const TicketViewSchema = z
  .object({
    key: z.string().openapi({ example: "PLAT-123" }),
    canonical: CanonicalTicket,
    status: z.string().nullable().openapi({ description: "assessed, needs_info, not_ours, duplicate, question, parked, scheduled, carded, handed_over, split_proposed, needs_decision…" }),
    assessments: z.array(z.record(z.string(), z.unknown())),
    drafts: z.array(DraftViewSchema),
    cardId: z.string().nullable(),
    clocks: z.record(z.string(), z.unknown()),
    splitTarget: z.string().nullable().openapi({ description: "The Jira project or GitHub `owner/repo` a split's child tickets are created in; null for any other key" }),
  })
  .openapi("TicketView");
expectSame<Same<z.infer<typeof TicketViewSchema>, TicketView>>();

export const TicketScheduledSchema = z.object({ id: z.string(), created: z.boolean() }).openapi("TicketScheduled");
expectSame<Same<z.infer<typeof TicketScheduledSchema>, Awaited<ReturnType<TicketMachine["schedule"]>>>>();
export const TicketCardSchema = z.object({ id: z.string() }).openapi("TicketCard");
expectSame<Same<z.infer<typeof TicketCardSchema>, Awaited<ReturnType<TicketMachine["card"]>>>>();

/** `:key` of a ticket: a Jira key or a url-encoded `owner/repo#n`. Any string reaches the handler: anything else is a 404. */
const KeyParams = z.object({ key: z.string().openapi({ param: { name: "key", in: "path" }, example: "PLAT-123", description: "A Jira key or url-encoded `owner/repo#n`" }) });

export const listTicketsRoute = createRoute({
  operationId: "listTickets",
  method: "get",
  path: "/tickets",
  tags: TAGS,
  summary: "The tickets the ticket machine holds",
  description: "Each with its `canonical` form, `status`, `assessments`, `drafts` (each with the `hash` a tap names), `cardId`, `clocks` and `splitTarget`.",
  responses: { 200: jsonContent(z.array(TicketViewSchema), "The tickets"), ...errorResponses() },
});

export const approveTicketRoute = createRoute({
  operationId: "approveTicket",
  method: "post",
  path: "/tickets/{key}/approve",
  tags: TAGS,
  summary: "Post a draft to the ticket",
  description: "Posts the draft the person saw (by its hash); with `transition` the ticket moves too. 409 for a stale hash, a draft already posted or ignored, or a `transition` on a GitHub ticket. Approving a split draft creates the child tickets.",
  request: { params: KeyParams, ...jsonBody(TicketApproveInput) },
  responses: { 200: jsonContent(TicketViewSchema, "The ticket after the tap"), ...errorResponses(400, 404, 409, 422) },
});

export const editTicketRoute = createRoute({
  operationId: "editTicket",
  method: "post",
  path: "/tickets/{key}/edit",
  tags: TAGS,
  summary: "Post the person's own text instead of a draft",
  description: "The text is flattened and refused with 409 when it carries a token. A split draft cannot be edited.",
  request: { params: KeyParams, ...jsonBody(TicketEditInput) },
  responses: { 200: jsonContent(TicketViewSchema, "The ticket after the tap"), ...errorResponses(400, 404, 409, 422) },
});

export const ignoreTicketRoute = createRoute({
  operationId: "ignoreTicket",
  method: "post",
  path: "/tickets/{key}/ignore",
  tags: TAGS,
  summary: "Keep a draft and never post it",
  request: { params: KeyParams, ...jsonBody(TicketIgnoreInput) },
  responses: { 200: jsonContent(TicketViewSchema, "The ticket after the tap"), ...errorResponses(400, 404, 409) },
});

export const scheduleTicketRoute = createRoute({
  operationId: "scheduleTicket",
  method: "post",
  path: "/tickets/{key}/backlog",
  tags: TAGS,
  summary: "Place the ticket in the shared backlog",
  description: "By its score, or updates its item. 409 unless it was assessed as workable.",
  request: { params: KeyParams },
  responses: { 201: jsonContent(TicketScheduledSchema, "The backlog item's id and whether it was created"), ...errorResponses(404, 409) },
});

export const cardTicketRoute = createRoute({
  operationId: "createCardFromTicket",
  method: "post",
  path: "/tickets/{key}/card",
  tags: TAGS,
  summary: "Make one card from the ticket",
  description: "The source, reporter and assessment go as hints; nothing is written to the ticket. 409 when it has one already.",
  request: { params: KeyParams },
  responses: { 201: jsonContent(TicketCardSchema, "The card's id"), ...errorResponses(404, 409) },
});
