// Closing the loop: what a merged PR tells the places the task came from. The pipeline records a
// `ship.merged` event when `shipping` passes with a merge (older rows are `task.shipped`); the board gets it as a stream message,
// and the issue, the Slack thread and the Jira ticket get one plain summary of it. Text that comes
// from a model (the pack's how-to-verify) is flattened like everything else the machine posts, and
// only web urls go out: a local path of the machine's is nobody else's business.
import type { StreamMessage } from "@hardness/contracts";
import { z } from "zod";

import { safe } from "../domain/evidence-markdown.ts";
import type { TaskRow } from "../domain/task.ts";

const isWeb = (url: string): boolean => /^https?:\/\//i.test(url);

/** The event kinds that mean "a PR merged": `ship.merged` is what the pipeline logs now, `task.shipped` is what older rows hold. Every reader takes both. */
export const SHIPPED_KINDS: ReadonlySet<string> = new Set(["ship.merged", "task.shipped"]);
export const isShippedKind = (kind: string): boolean => SHIPPED_KINDS.has(kind);

/** The `ship.merged` event's payload (and a stored `task.shipped` one, which has no `method`). */
export const ShippedEvent = z.object({
  title: z.string(),
  prUrl: z.string(),
  number: z.number().int(),
  mergedSha: z.string().nullable(),
  by: z.enum(["machine", "person"]),
  /** The merge method the machine asked for (`ship.merge.method`); absent on a person's merge and on a row from before this wave. */
  method: z.enum(["squash", "merge", "rebase"]).optional(),
  format: z.string().nullable(),
  howToVerify: z.string().nullable(),
  media: z.array(z.object({ kind: z.string(), label: z.string(), url: z.string() })),
});
export type ShippedEvent = z.infer<typeof ShippedEvent>;

/** The event for a shipping run that merged, from the task's pack and the stage's detail; null when the detail names no merge. */
export function shippedEvent(task: Pick<TaskRow, "title" | "evidence">, detail: Record<string, unknown> | undefined): ShippedEvent | null {
  const merged = detail?.merged as { sha?: unknown; by?: unknown; method?: unknown } | undefined;
  if (!merged || typeof detail?.prUrl !== "string" || typeof detail.number !== "number") return null;
  const pack = task.evidence;
  return {
    title: task.title,
    prUrl: detail.prUrl,
    number: detail.number,
    mergedSha: typeof merged.sha === "string" ? merged.sha : null,
    by: merged.by === "machine" ? "machine" : "person",
    ...(merged.method === "squash" || merged.method === "merge" || merged.method === "rebase" ? { method: merged.method } : {}),
    format: pack?.format ?? null,
    howToVerify: pack?.howToVerify ?? null,
    media: (pack?.media ?? []).filter((m) => isWeb(m.url)).map((m) => ({ kind: m.kind, label: m.label, url: m.url })),
  };
}

/** The one plain message a merged task leaves where it came from. */
export function shippedSummary(event: ShippedEvent): string {
  const sha = event.mergedSha ? ` (${event.mergedSha.slice(0, 7)})` : "";
  const how = event.howToVerify ? ` How to verify: ${safe(event.howToVerify).slice(0, 400)}.`.replace(/\.\.$/, ".") : "";
  const links = event.media.filter((m) => isWeb(m.url)).map((m) => `${safe(m.label)} (${m.url})`);
  const evidence = event.format || links.length > 0 ? ` Evidence: ${[event.format, links.join(", ")].filter(Boolean).join("; ")}.` : "";
  return `Shipped: ${safe(event.title)} — ${event.prUrl}${sha}.${how}${evidence}`;
}

/** The stream message for a logged `task.shipped` event; null for any other event or a payload that is not one. */
export function shippedStream(event: { taskId: string; kind: string; payload: Record<string, unknown>; at: Date | string }): StreamMessage | null {
  if (!isShippedKind(event.kind)) return null;
  const parsed = ShippedEvent.safeParse(event.payload);
  if (!parsed.success) return null;
  const { title, prUrl, number, mergedSha, format, howToVerify, media } = parsed.data;
  return { type: "task.shipped", shipped: { id: event.taskId, title, prUrl, number, mergedSha, format, howToVerify, media, at: new Date(event.at).toISOString() } };
}
