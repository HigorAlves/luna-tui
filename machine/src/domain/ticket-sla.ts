// A ticket's clocks, pure: acknowledge within a time, resolve by priority, stale after a number of days, and the waiting-for-the-reporter pair
// (a reminder, then a park). Each number is the repository's (`tickets.sla`), with defaults. A clock only says when something is due: it never
// posts and never approves; what an overdue one leads to is a draft (ticket-machine.ts `sweepClocks`).
import type { FactoryConfig } from "@hardness/contracts";

const HOUR = 3_600_000;
const DAY = 86_400_000;

export interface ClockInput {
  firstSeenAt: Date;
  /** When a person first tapped on the ticket; null until then. */
  acknowledgedAt: Date | null;
  /** The P level of its latest assessment; null before one. */
  priority: "P0" | "P1" | "P2" | "P3" | null;
  /** The machine's status for it. */
  status: string | null;
  /** When it started waiting for its reporter. */
  needsInfoSince: Date | null;
  /** The last time anything on it changed. */
  updatedAt: Date;
}

export type ClockName = "acknowledge" | "resolve" | "stale" | "needs_info_reminder" | "needs_info_park";
export interface Clock {
  name: ClockName;
  dueAt: Date;
  overdue: boolean;
}

/** Statuses after which the ticket is the card's, someone else's, or over: no resolve or stale clock. */
const ENDED = new Set(["carded", "handed_over", "duplicate", "not_ours", "parked"]);

export function ticketClocks(t: ClockInput, now: Date, config: FactoryConfig["tickets"]): Clock[] {
  const sla = config.sla;
  const out: Clock[] = [];
  const add = (name: ClockName, dueAt: Date) => out.push({ name, dueAt, overdue: now.getTime() > dueAt.getTime() });
  if (t.acknowledgedAt === null) add("acknowledge", new Date(t.firstSeenAt.getTime() + sla.acknowledge_hours * HOUR));
  if (!ENDED.has(t.status ?? "")) {
    if (t.priority) add("resolve", new Date(t.firstSeenAt.getTime() + sla.resolve_days[t.priority] * DAY));
    add("stale", new Date(t.updatedAt.getTime() + sla.stale_days * DAY));
  }
  if (t.status === "needs_info" && t.needsInfoSince) {
    add("needs_info_reminder", new Date(t.needsInfoSince.getTime() + sla.needs_info_reminder_days * DAY));
    add("needs_info_park", new Date(t.needsInfoSince.getTime() + sla.needs_info_park_days * DAY));
  }
  return out;
}
