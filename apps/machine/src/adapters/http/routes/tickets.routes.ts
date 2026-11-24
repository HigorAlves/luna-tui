// The Ticket Machine's taps.
import { TicketApproveInput, TicketEditInput, TicketIgnoreInput } from "@hardness/contracts";
import type { Context } from "hono";
import { createOpenApiRouter } from "../openapi/router.ts";
import { body, type RouteDeps } from "./kit.ts";

export function ticketsRoutes(deps: RouteDeps) {
  const { backlog, tickets } = deps;
  const app = createOpenApiRouter();
  if (tickets) {
    // The taps. Each is a person's request; nothing else in the machine reaches a write on a ticket. `:key` is checked in the machine before any store or adapter sees it.
    const key = (c: Context): string => c.req.param("key") ?? "";
    app.get("/tickets", async (c) => c.json(await tickets.list()));
    app.post("/tickets/:key/approve", async (c) => (await tickets.approve(key(c), await body(c, TicketApproveInput)), c.json(await tickets.view(key(c)))));
    app.post("/tickets/:key/edit", async (c) => (await tickets.edit(key(c), await body(c, TicketEditInput)), c.json(await tickets.view(key(c)))));
    app.post("/tickets/:key/ignore", async (c) => (await tickets.ignore(key(c), await body(c, TicketIgnoreInput)), c.json(await tickets.view(key(c)))));
    app.post("/tickets/:key/backlog", async (c) => c.json(await tickets.schedule(key(c)), 201));
    app.post("/tickets/:key/card", async (c) => c.json(await tickets.card(key(c)), 201));
  }
  return app;
}
