// OpenAPI route definitions of the token economy (RFC 0007). The routes exist only with the economy on (`MACHINE_ECONOMY`).
import { EconomyApproveInput, EconomyApproved, EconomyDropped, EconomyRepoInput, EconomyRestoreInput, EconomyStatus } from "@hardness/contracts";
import { createRoute, z } from "@hono/zod-openapi";

import type { Economy } from "../../../application/economy.ts";
import { errorResponses, expectSame, jsonBody, jsonContent, type Same } from "../openapi/schemas.ts";

const TAGS = ["Economy"];

export const EconomyStatusSchema = z.object(EconomyStatus.shape).openapi("EconomyStatus");
expectSame<Same<z.infer<typeof EconomyStatusSchema>, Awaited<ReturnType<Economy["status"]>>>>();

export const EconomyRestored = z.object({ restored: z.boolean() }).openapi("EconomyRestored");
expectSame<Same<z.infer<typeof EconomyRestored>, { restored: Awaited<ReturnType<Economy["restore"]>> }>>();
expectSame<Same<z.infer<typeof EconomyDropped>, { dropped: Awaited<ReturnType<Economy["dropFact"]>> }>>();
expectSame<Same<z.infer<typeof EconomyApproved>, { approved: Awaited<ReturnType<Economy["approveMask"]>> }>>();
export const EconomyImported = z.object({ runs: z.number().int() }).openapi("EconomyImported");
expectSame<Same<z.infer<typeof EconomyImported>, { runs: Awaited<ReturnType<Economy["importRuns"]>> }>>();

export const economyStatusRoute = createRoute({
  operationId: "getEconomy",
  method: "get",
  path: "/economy",
  tags: TAGS,
  summary: "The token economy of one repository",
  description: "Envelopes per pack, the loop guard's last events, the cost in effective tokens, the learned facts and the tool proposals. 400 unless `repo` is an absolute path of a repository the machine knows.",
  request: { query: z.object({ repo: z.string().optional().openapi({ description: "Absolute path of a repository the machine knows", example: "/Users/me/shop" }) }) },
  responses: { 200: jsonContent(EconomyStatusSchema, "What the economy knows"), ...errorResponses(400) },
});

export const dropFactRoute = createRoute({
  operationId: "dropEconomyFact",
  method: "post",
  path: "/economy/facts/{id}/drop",
  tags: TAGS,
  summary: "Drop a learned fact",
  description: "The fact is wrong: it is never told again and its key is never learned again. `dropped` is false for an id the repository does not hold.",
  request: { params: z.object({ id: z.string().openapi({ param: { name: "id", in: "path" }, description: "The fact's id" }) }), ...jsonBody(EconomyRepoInput) },
  responses: { 200: jsonContent(EconomyDropped, "Whether a fact was dropped"), ...errorResponses(400) },
});

export const approveMaskRoute = createRoute({
  operationId: "approveEconomyMask",
  method: "post",
  path: "/economy/mask/approve",
  tags: TAGS,
  summary: "Approve the tools proposed for a pack",
  description: "The proposed tools become the pack's mask, and its next run starts without them. `approved` is false when the pack has no proposal.",
  request: jsonBody(EconomyApproveInput),
  responses: { 200: jsonContent(EconomyApproved, "Whether a mask was approved"), ...errorResponses(400) },
});

export const restoreMaskRoute = createRoute({
  operationId: "restoreEconomyMask",
  method: "post",
  path: "/economy/mask/restore",
  tags: TAGS,
  summary: "Bring a unit back into a pack",
  description: "A unit (`web`, `agent`, `luna:<tool>`) comes back into the pack and is not proposed again. `restored` is false for a unit the pack does not have.",
  request: jsonBody(EconomyRestoreInput),
  responses: { 200: jsonContent(EconomyRestored, "Whether a unit was restored"), ...errorResponses(400) },
});

export const importRunsRoute = createRoute({
  operationId: "importEconomyRuns",
  method: "post",
  path: "/economy/import",
  tags: TAGS,
  summary: "Fold the runs already on disk, once",
  description: "Teaches the envelopes from passing runs and the tool evidence from Claude runs. A run is never folded twice, so a second call answers `{ runs: 0 }`.",
  request: jsonBody(EconomyRepoInput),
  responses: { 200: jsonContent(EconomyImported, "How many runs were folded"), ...errorResponses(400) },
});
