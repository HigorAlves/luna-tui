// What the conversation machine may read: only what a person opted in. Pure.
import type { ChannelKind, SlackWatch } from "@hardness/contracts";

export type SlackScope = "opted_in" | "all";

/** The conversations a person opted in: the channel of every enabled `channel` watch (the board's `W` editor) and every channel a known repository's `luna.yaml` lists. A DM or a group DM is in by its own id in one of the two. */
export function optedIn(watches: SlackWatch[], claimed: Iterable<string>): Set<string> {
  const opted = new Set<string>(claimed);
  for (const watch of watches) if (watch.enabled && watch.kind === "channel") opted.add(watch.value);
  return opted;
}

/** Whether a conversation is read at all. `all` is the operator's own switch (`MACHINE_SLACK_SCOPE`). */
export function inConversationScope(channel: { id: string; kind: ChannelKind }, opted: ReadonlySet<string>, scope: SlackScope): boolean {
  return scope === "all" || opted.has(channel.id);
}
