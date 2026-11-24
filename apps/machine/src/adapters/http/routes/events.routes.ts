// Live updates over Server-Sent Events.
import { CARD_EVENT_NAMES, CardEventName, type StreamMessage } from "@hardness/contracts";
import { streamSSE } from "hono/streaming";
import type { TaskRow } from "../../../domain/task.ts";
import { ReplayFeed } from "../replay.ts";
import { createOpenApiRouter } from "../openapi/router.ts";
import { PING_EVERY_MS, SOURCE_KINDS, BadRequest, taskId, type RouteDeps } from "./kit.ts";

export function eventsRoutes(deps: RouteDeps) {
  const { pipeline, bus, serialize } = deps;
  const app = createOpenApiRouter();
  /** Live updates; `since` replays the task changes past that sequence number first, `source` keeps one source's tasks (see replay.ts). `ready` follows the replay. */
  app.get("/events", (c) => {
    const since = c.req.query("since");
    const source = c.req.query("source") ?? null;
    const wanted = c.req.query("names");
    const names = wanted === undefined ? null : new Set(wanted.split(",").map((n) => n.trim()).filter((n) => n !== ""));
    for (const n of names ?? []) if (!CardEventName.safeParse(n).success) throw new BadRequest(`names must be diagram event names (${CARD_EVENT_NAMES.join(", ")}), got "${n.slice(0, 40)}"`);
    if (since !== undefined && !/^\d+$/.test(since)) throw new BadRequest(`since must be a sequence number, got "${since}"`);
    if (source !== null && !SOURCE_KINDS.includes(source)) throw new BadRequest(`source must be one of ${SOURCE_KINDS.join(", ")}, got "${source}"`);
    return streamSSE(c, async (stream) => {
      let unsubscribe = () => {};
      const write = (message: StreamMessage) =>
        stream.writeSSE({ event: message.type, data: JSON.stringify(message) }).catch((error: unknown) => {
          console.error(`SSE write failed, dropping this listener: ${error}`);
          unsubscribe();
        });
      const deps = {
        changesSince: (after: number, kind: string | null) => pipeline.changesSince(after, kind),
        lastSeq: () => pipeline.lastSeq(),
        serialize: async (row: TaskRow) => serialize(row, await pipeline.taskUsage(row.id)),
        sourceOf: (taskId: string) => pipeline.get(taskId).then((task) => task.source?.kind ?? null, () => null),
        write,
      };
      const feed = since === undefined && source === null && names === null ? null : new ReplayFeed(deps, since === undefined ? null : Number(since), source, names as ReadonlySet<CardEventName> | null);
      unsubscribe = bus.subscribe((message) => (feed ? feed.offer(message) : void write(message)));
      stream.onAbort(unsubscribe);

      await feed?.read();
      await stream.writeSSE({ event: "ready", data: "{}" });
      while (!stream.aborted) {
        await stream.sleep(PING_EVERY_MS);
        if (!stream.aborted) await stream.writeSSE({ event: "ping", data: "{}" });
      }
    });
  });
  return app;
}
