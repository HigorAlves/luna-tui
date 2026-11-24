// The Ticket Machine's taps.
import type { Context } from "hono";
import { createOpenApiRouter } from "../openapi/router.ts";
import type { RouteDeps } from "./kit.ts";
import { approveTicketRoute, cardTicketRoute, editTicketRoute, ignoreTicketRoute, listTicketsRoute, scheduleTicketRoute } from "./tickets.openapi.ts";

export function ticketsRoutes(deps: RouteDeps) {
  const { backlog, tickets } = deps;
  const app = createOpenApiRouter();
  if (tickets) {
    // The taps. Each is a person's request; nothing else in the machine reaches a write on a ticket. `:key` is checked in the machine before any store or adapter sees it.
    const key = (c: Context): string => c.req.param("key") ?? "";
    app.openapi(listTicketsRoute, async (c) => c.json(await tickets.list(), 200));
    app.openapi(approveTicketRoute, async (c) => (await tickets.approve(key(c), c.req.valid("json")), c.json(await tickets.view(key(c)), 200)));
    app.openapi(editTicketRoute, async (c) => (await tickets.edit(key(c), c.req.valid("json")), c.json(await tickets.view(key(c)), 200)));
    app.openapi(ignoreTicketRoute, async (c) => (await tickets.ignore(key(c), c.req.valid("json")), c.json(await tickets.view(key(c)), 200)));
    app.openapi(scheduleTicketRoute, async (c) => c.json(await tickets.schedule(key(c)), 201));
    app.openapi(cardTicketRoute, async (c) => c.json(await tickets.card(key(c)), 201));
  }
  return app;
}
