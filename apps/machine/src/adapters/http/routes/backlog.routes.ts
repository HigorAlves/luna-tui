// The shared backlog.
import { BacklogAddInput } from "@hardness/contracts";
import type { Context } from "hono";
import { BacklogItemNotFoundError } from "../../../application/backlog.ts";
import { z } from "zod";
import { createOpenApiRouter } from "../openapi/router.ts";
import { body, type RouteDeps } from "./kit.ts";

export function backlogRoutes(deps: RouteDeps) {
  const { bus, backlog, serialize } = deps;
  const app = createOpenApiRouter();
  if (backlog) {
    const itemId = (c: Context): string => {
      const id = c.req.param("id") ?? "";
      if (!z.uuid().safeParse(id).success) throw new BacklogItemNotFoundError(id);
      return id;
    };
    app.get("/backlog", async (c) => c.json(await backlog.list()));
    app.post("/backlog", async (c) => c.json(await backlog.add(await body(c, BacklogAddInput)), 201));
    app.post("/backlog/:id/bump", async (c) => c.json(await backlog.bump(itemId(c))));
    app.post("/backlog/:id/promote", async (c) => {
      const task = await serialize(await backlog.promote(itemId(c)));
      bus.publish({ type: "task.updated", task, seq: task.seq });
      return c.json(task, 201);
    });
    app.post("/backlog/:id/decline", async (c) => {
      const id = itemId(c);
      await backlog.decline(id);
      return c.json({ id });
    });
  }
  return app;
}
