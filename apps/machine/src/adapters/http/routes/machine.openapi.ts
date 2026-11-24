// OpenAPI route definitions of the machine's own routes (workbench's `<area>.openapi.ts`): each route's
// request and every response it can give, in zod, so `GET /openapi.json` describes them and the router
// validates them. Response schemas are held to the contracts' types with `expectSame`.
import { MachinePolicySchema, type Slots } from "@hardness/contracts";
import { createRoute, z } from "@hono/zod-openapi";

import { errorResponses, expectSame, jsonBody, jsonContent, type Same } from "../openapi/schemas.ts";

const TAGS = ["Machine"];

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
