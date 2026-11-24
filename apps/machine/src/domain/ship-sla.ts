// The clocks of a watched PR (diagram panel 7): quiet for `reminder_days` earns one reminder, quiet for `escalate_days` and
// already reminded earns one escalation to the release owners. Pure: the cursor keeps the three dates. A clock never merges,
// approves or archives; activity starts the period again (the caller clears `remindedAt` and `escalatedAt`, and a date
// from before the last activity does not count here either).
const DAY_MS = 86_400_000;

export interface ShipSlaInput {
  lastActivityAt: string;
  remindedAt: string | null;
  escalatedAt: string | null;
  now: Date;
  /** 0 turns the reminder off. */
  reminderDays: number;
  /** 0 turns the escalation off. */
  escalateDays: number;
}

export function shipSla(input: ShipSlaInput): "remind" | "escalate" | null {
  const last = Date.parse(input.lastActivityAt);
  if (Number.isNaN(last)) return null;
  const quiet = input.now.getTime() - last;
  const inPeriod = (at: string | null) => at !== null && Date.parse(at) >= last;
  if (input.escalateDays > 0 && quiet >= input.escalateDays * DAY_MS && inPeriod(input.remindedAt) && !inPeriod(input.escalatedAt)) return "escalate";
  if (input.reminderDays > 0 && quiet >= input.reminderDays * DAY_MS && !inPeriod(input.remindedAt)) return "remind";
  return null;
}

/** Whole days the PR has been quiet, for the fixed line. */
export const quietDays = (lastActivityAt: string, now: Date): number => Math.max(0, Math.floor((now.getTime() - Date.parse(lastActivityAt)) / DAY_MS));
