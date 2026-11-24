// Jira by hand.
import { JiraCreateInput, JiraLinkInput } from "@hardness/contracts";
import type { Context } from "hono";
import type { TaskRow } from "../../../domain/task.ts";
import { createOpenApiRouter } from "../openapi/router.ts";
import { body, taskId, type RouteDeps } from "./kit.ts";

export function jiraRoutes(deps: RouteDeps) {
  const { pipeline, bus, jira, serialize } = deps;
  const app = createOpenApiRouter();
  if (jira) {
    // Jira by hand (`J` on a ticket): link an issue, unlink it, create one from the ticket, search
    // issues to pick from, and whether the token works. The automatic part (JiraSync, JiraIntake,
    // JiraWatch) needs no route.
    app.get("/jira/status", async (c) => c.json(await jira.status()));
    app.get("/jira/search", async (c) => c.json(await jira.search(c.req.query("q") ?? "")));
    const linked = async (c: Context, task: TaskRow, status: 200 | 201 = 200) => {
      const out = await serialize(task, await pipeline.taskUsage(task.id));
      bus.publish({ type: "task.updated", task: out, seq: out.seq });
      return c.json(out, status);
    };
    app.post("/tasks/:id/jira", async (c) => {
      const id = taskId(c);
      const { key } = await body(c, JiraLinkInput);
      return linked(c, await jira.link(id, key));
    });
    app.delete("/tasks/:id/jira", async (c) => linked(c, await jira.unlink(taskId(c))));
    app.post("/tasks/:id/jira/create", async (c) => {
      const id = taskId(c);
      return linked(c, await jira.create(id, await body(c, JiraCreateInput)), 201);
    });
  }
  return app;
}
