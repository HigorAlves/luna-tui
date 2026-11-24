// Jira by hand.
import type { TaskRow } from "../../../domain/task.ts";
import { createOpenApiRouter } from "../openapi/router.ts";
import { createJiraRoute, jiraSearchRoute, jiraStatusRoute, linkJiraRoute, unlinkJiraRoute } from "./jira.openapi.ts";
import { taskId, type RouteDeps } from "./kit.ts";

export function jiraRoutes(deps: RouteDeps) {
  const { pipeline, bus, jira, serialize } = deps;
  const app = createOpenApiRouter();
  if (jira) {
    // Jira by hand (`J` on a ticket): link an issue, unlink it, create one from the ticket, search
    // issues to pick from, and whether the token works. The automatic part (JiraSync, JiraIntake,
    // JiraWatch) needs no route.
    const linked = async (task: TaskRow) => {
      const out = await serialize(task, await pipeline.taskUsage(task.id));
      bus.publish({ type: "task.updated", task: out, seq: out.seq });
      return out;
    };
    app.openapi(jiraStatusRoute, async (c) => c.json(await jira.status(), 200));
    app.openapi(jiraSearchRoute, async (c) => c.json(await jira.search(c.req.valid("query").q ?? ""), 200));
    app.openapi(linkJiraRoute, async (c) => {
      const id = taskId(c);
      return c.json(await linked(await jira.link(id, c.req.valid("json").key)), 200);
    });
    app.openapi(unlinkJiraRoute, async (c) => c.json(await linked(await jira.unlink(taskId(c))), 200));
    app.openapi(createJiraRoute, async (c) => {
      const id = taskId(c);
      return c.json(await linked(await jira.create(id, c.req.valid("json"))), 201);
    });
  }
  return app;
}
