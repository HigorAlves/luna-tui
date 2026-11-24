// The Slack inbox.
import { tapOf } from "../../../application/slack-send.ts";
import { InvalidSince, parseSince } from "../metrics.ts";
import { createOpenApiRouter } from "../openapi/router.ts";
import { BadRequest, type RouteDeps } from "./kit.ts";
import { addWatchRoute, channelsRoute, deleteWatchRoute, itemsRoute, itemTaskRoute, metricsRoute, patchItemRoute, patchWatchRoute, refreshRoute, relateItemRoute, replyItemRoute, triageRunsRoute, usergroupsRoute, watchesRoute } from "./slack.openapi.ts";

export function slackRoutes(deps: RouteDeps) {
  const { slack, runs, serialize } = deps;
  const app = createOpenApiRouter();
  if (slack) {
    // The Slack inbox: the snapshot, a poll on demand, your actions on an item, the watches,
    // how fast you answer, and the listings the board's watch popup completes from.
    app.openapi(itemsRoute, (c) => c.json(slack.snapshot, 200));
    app.openapi(refreshRoute, async (c) => c.json(await slack.pollOnce(true), 200));
    app.openapi(patchItemRoute, async (c) => c.json(await slack.patch(c.req.param("id"), c.req.valid("json"), tapOf("PATCH /slack/items/:id")), 200));
    app.openapi(relateItemRoute, async (c) => c.json(await slack.relate(c.req.param("id"), c.req.valid("json")), 200));
    app.openapi(replyItemRoute, async (c) => {
      const { text, nudge, draftId, draftHash } = c.req.valid("json");
      return c.json(await slack.reply(c.req.param("id"), text, tapOf("POST /slack/items/:id/reply"), nudge ?? false, draftId && draftHash ? { id: draftId, hash: draftHash } : undefined), 200);
    });
    app.openapi(itemTaskRoute, async (c) => c.json(await serialize(await slack.toTask(c.req.param("id"), c.req.valid("json"), tapOf("POST /slack/items/:id/task"))), 201));
    app.openapi(watchesRoute, async (c) => c.json(await slack.watches(), 200));
    app.openapi(addWatchRoute, async (c) => c.json(await slack.addWatch(c.req.valid("json")), 201));
    app.openapi(patchWatchRoute, async (c) => c.json(await slack.patchWatch(c.req.param("id"), c.req.valid("json")), 200));
    app.openapi(deleteWatchRoute, async (c) => {
      await slack.deleteWatch(c.req.param("id"));
      return c.body(null, 204);
    });
    const sinceOf = (value: string | undefined): Date => {
      try {
        return parseSince(value);
      } catch (error) {
        if (error instanceof InvalidSince) throw new BadRequest(error.message);
        throw error;
      }
    };
    app.openapi(metricsRoute, async (c) => c.json(await slack.metrics(sinceOf(c.req.query("since"))), 200));
    // What the slack_triage pack cost: one row per container run, items and dollars summed.
    app.openapi(triageRunsRoute, async (c) => c.json(await slack.triageRuns(sinceOf(c.req.query("since"))), 200));
    app.openapi(usergroupsRoute, async (c) => c.json(await slack.usergroups(), 200));
    app.openapi(channelsRoute, async (c) => c.json(await slack.channels(), 200));
  }
  return app;
}
