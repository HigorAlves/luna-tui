// The Ticket Machine's first question about a ticket: is it assigned to me or my team? Pure. Anything else is ignored, with no
// comment and no object. A repository's own JQL or label filter still runs first and narrows this further.
import type { CanonicalTicket, FactoryConfig } from "@hardness/contracts";

const norm = (s: string): string => s.trim().toLowerCase();

/** A ticket of one of the configured assignees, or of a configured team by label or component. Nothing configured: nothing is in scope. */
export function inScope(ticket: Pick<CanonicalTicket, "assignee" | "labels" | "components">, config: Pick<FactoryConfig["tickets"], "assignees" | "teams">): boolean {
  const people = new Set(config.assignees.map(norm));
  if (ticket.assignee !== null && people.has(norm(ticket.assignee))) return true;
  const teams = new Set(config.teams.map(norm));
  return [...ticket.labels, ...ticket.components].some((name) => teams.has(norm(name)));
}

/** Whether a ticket last touched at `updatedAt` has been quiet for `debounceSeconds`, so a burst of edits is one read. An unusable stamp reads now. */
export function settled(updatedAt: string | null, now: Date, debounceSeconds: number): boolean {
  const at = Date.parse(updatedAt ?? "");
  if (Number.isNaN(at)) return true;
  return now.getTime() - at >= debounceSeconds * 1000;
}

/** Whether any scope is configured at all: with none, a repository's own filter is the whole scope, as before this wave. */
export function scopeConfigured(config: Pick<FactoryConfig["tickets"], "assignees" | "teams">): boolean {
  return config.assignees.length > 0 || config.teams.length > 0;
}
