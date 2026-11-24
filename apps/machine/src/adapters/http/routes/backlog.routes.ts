// The shared backlog.
import type { Context } from "hono";
import { BacklogItemNotFoundError } from "../../../application/backlog.ts";
import { z } from "zod";
import { createOpenApiRouter } from "../openapi/router.ts";
import { addBacklogRoute, bumpBacklogRoute, declineBacklogRoute, listBacklogRoute, promoteBacklogRoute } from "./backlog.openapi.ts";
import type { RouteDeps } from "./kit.ts";

export function backlogRoutes(deps: RouteDeps) {
  const { bus, backlog, serialize } = deps;
  const app = createOpenApiRouter();
  if (backlog) {
    const itemId = (c: Context): string => {
      const id = c.req.param("id") ?? "";
      if (!z.uuid().safeParse(id).success) throw new BacklogItemNotFoundError(id);
      return id;
    };
    app.openapi(listBacklogRoute, async (c) => c.json(await backlog.list(), 200));
    app.openapi(addBacklogRoute, async (c) => c.json(await backlog.add(c.req.valid("json")), 201));
    app.openapi(bumpBacklogRoute, async (c) => c.json(await backlog.bump(itemId(c)), 200));
    app.openapi(promoteBacklogRoute, async (c) => {
      const task = await serialize(await backlog.promote(itemId(c)));
      bus.publish({ type: "task.updated", task, seq: task.seq });
      return c.json(task, 201);
    });
    app.openapi(declineBacklogRoute, async (c) => {
      const id = itemId(c);
      await backlog.decline(id);
      return c.json({ id }, 200);
    });
  }
  return app;
}
