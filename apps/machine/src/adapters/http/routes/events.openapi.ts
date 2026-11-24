// OpenAPI definition of the live stream: `GET /events` is Server-Sent Events, so its 200 is `text/event-stream`, not JSON.
import { createRoute, z } from "@hono/zod-openapi";

import { errorResponses } from "../openapi/schemas.ts";

export const eventsRoute = createRoute({
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
      content: { "text/event-stream": { schema: z.string().openapi({ description: "`event: <type>\\ndata: <JSON message>\\n\\n` frames" }) } },
    },
    ...errorResponses(400),
  },
});
