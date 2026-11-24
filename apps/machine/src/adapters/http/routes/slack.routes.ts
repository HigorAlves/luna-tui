// The Slack inbox.
import { SlackItemPatch, SlackRelationInput, SlackReplyInput, SlackTaskInput, SlackWatchInput, SlackWatchPatch } from "@hardness/contracts";
import { tapOf } from "../../../application/slack-send.ts";
import { InvalidSince, parseSince } from "../metrics.ts";
import { createOpenApiRouter } from "../openapi/router.ts";
import { BadRequest, body, type RouteDeps } from "./kit.ts";

export function slackRoutes(deps: RouteDeps) {
  const { slack, runs, serialize } = deps;
  const app = createOpenApiRouter();
  if (slack) {
    // The Slack inbox: the snapshot, a poll on demand, your actions on an item, the watches,
    // how fast you answer, and the listings the board's watch popup completes from.
    app.get("/slack/items", (c) => c.json(slack.snapshot));
    app.post("/slack/refresh", async (c) => c.json(await slack.pollOnce(true)));
    app.patch("/slack/items/:id", async (c) => c.json(await slack.patch(c.req.param("id"), await body(c, SlackItemPatch), tapOf("PATCH /slack/items/:id"))));
    app.post("/slack/items/:id/relation", async (c) => c.json(await slack.relate(c.req.param("id"), await body(c, SlackRelationInput))));
    app.post("/slack/items/:id/reply", async (c) => {
      const { text, nudge, draftId, draftHash } = await body(c, SlackReplyInput);
      return c.json(await slack.reply(c.req.param("id"), text, tapOf("POST /slack/items/:id/reply"), nudge ?? false, draftId && draftHash ? { id: draftId, hash: draftHash } : undefined));
    });
    app.post("/slack/items/:id/task", async (c) => c.json(await serialize(await slack.toTask(c.req.param("id"), await body(c, SlackTaskInput), tapOf("POST /slack/items/:id/task"))), 201));
    app.get("/slack/watches", async (c) => c.json(await slack.watches()));
    app.post("/slack/watches", async (c) => c.json(await slack.addWatch(await body(c, SlackWatchInput)), 201));
    app.patch("/slack/watches/:id", async (c) => c.json(await slack.patchWatch(c.req.param("id"), await body(c, SlackWatchPatch))));
    app.delete("/slack/watches/:id", async (c) => {
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
    app.get("/slack/metrics", async (c) => c.json(await slack.metrics(sinceOf(c.req.query("since")))));
    // What the slack_triage pack cost: one row per container run, items and dollars summed.
    app.get("/slack/triage-runs", async (c) => c.json(await slack.triageRuns(sinceOf(c.req.query("since")))));
    app.get("/slack/usergroups", async (c) => c.json(await slack.usergroups()));
    app.get("/slack/channels", async (c) => c.json(await slack.channels()));
  }
  return app;
}
