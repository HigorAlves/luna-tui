// What the minute tick does about a gate that has waited too long (RFC 0005): remind once per
// gate entry, and archive a ticket left at an intake gate (setup, triage's questions) past
// the repo's `sla.archive`, else five days. `slaActions` only decides, from the clocks and what was already said; the apply
// step records and archives. A later gate (the plan, the tests, ship) is only ever reminded of:
// work that has been approved is never thrown away by a clock.
import type { ArchiveReason, TaskSla, TaskState } from "@hardness/contracts";

import type { SlaTargets } from "../domain/sla.ts";
import type { TaskRow } from "../domain/task.ts";

export type SlaAction =
  | { taskId: string; action: "remind"; gate: TaskState; dueAt: string }
  | { taskId: string; action: "escalate"; gate: TaskState; to: string[]; afterSecs: number }
  | { taskId: string; action: "archive"; reason: SlaArchiveReason; gate: TaskState };

/** Why a card left unattended at an intake gate is archived: nobody set up the repo, nobody answered. */
export type SlaArchiveReason = Extract<ArchiveReason, "no_setup" | "no_answer">;
const REASON_AT: Record<string, SlaArchiveReason> = { awaiting_setup: "no_setup", awaiting_answers: "no_answer" };

/** The gates a ticket may be archived from: before anything was approved. */
export const AUTO_ARCHIVE_GATES: ReadonlySet<TaskState> = new Set<TaskState>(["awaiting_setup", "awaiting_answers"]);

/** An archive needs a reminder this long behind it, in this visit to the gate. */
export const REMINDER_BEFORE_ARCHIVE_MS = 24 * 3_600_000;

export interface SlaRow {
  task: TaskRow;
  sla: TaskSla | null;
  /** The repo's own targets. */
  targets: Partial<SlaTargets>;
  /** When the last `sla.reminder` event of this task was recorded; null when none. */
  lastReminderAt: Date | null;
  /** How long a card may wait at an intake gate when the repo's `sla` block says nothing (the diagram's `triage.sla.archive_days`); null or absent: never. */
  defaultArchive?: number | null;
  /** How long the plan gate may wait before it escalates to a person (the diagram's `plan.sla.escalate_days`), in seconds; null or absent: never. */
  escalateAfter?: number | null;
  /** When the last `sla.escalated` event of this task was recorded; null when none. */
  lastEscalationAt?: Date | null;
  /** Who the escalation names: the code map's owners, when the plan has them. */
  escalateTo?: string[];
}

/** The gate that escalates: the plan's. A gate past it is reminded of and, at the plan, escalated; never archived. */
const ESCALATING_GATE: TaskState = "awaiting_approval";

export function slaActions(rows: SlaRow[], now: Date): SlaAction[] {
  const actions: SlaAction[] = [];
  for (const { task, sla, targets, lastReminderAt, defaultArchive, escalateAfter, lastEscalationAt, escalateTo } of rows) {
    const gate = task.state as TaskState;
    const since = task.stateSince ?? task.createdAt;
    // The repo's block wins, `sla.archive: off` included; the diagram's five days apply when it says nothing. The clock is the gate's own: an answer moves the card and a new wait starts it again.
    const archiveAfter = targets.archive !== undefined ? targets.archive : (defaultArchive ?? null);
    // Never archive a visit nobody was reminded of at least a day before: after a long downtime the first tick reminds, a later one archives.
    const reminded = lastReminderAt !== null && lastReminderAt.getTime() >= since.getTime() && now.getTime() - lastReminderAt.getTime() >= REMINDER_BEFORE_ARCHIVE_MS;
    if (AUTO_ARCHIVE_GATES.has(gate) && typeof archiveAfter === "number" && since && now.getTime() - since.getTime() >= archiveAfter * 1000 && reminded) {
      actions.push({ taskId: task.id, action: "archive", reason: REASON_AT[gate] ?? "no_answer", gate });
      continue;
    }
    // The plan gate escalates once per visit, after a reminder: past `plan.sla.escalate_days` somebody is named.
    const inThisVisit = (at: Date | null | undefined) => at !== null && at !== undefined && at.getTime() >= since.getTime();
    if (gate === ESCALATING_GATE && typeof escalateAfter === "number" && now.getTime() - since.getTime() >= escalateAfter * 1000 && inThisVisit(lastReminderAt) && !inThisVisit(lastEscalationAt)) {
      actions.push({ taskId: task.id, action: "escalate", gate, to: escalateTo ?? [], afterSecs: escalateAfter });
      continue;
    }
    const clock = sla?.gate;
    if (clock?.overdue && (lastReminderAt === null || (since && lastReminderAt.getTime() < since.getTime()))) {
      actions.push({ taskId: task.id, action: "remind", gate, dueAt: clock.dueAt });
    }
  }
  return actions;
}

export interface SlaEffects {
  record(taskId: string, kind: string, payload: Record<string, unknown>): Promise<void>;
  archive(taskId: string, reason: SlaArchiveReason): Promise<TaskRow>;
}

/** Does what `slaActions` decided; one failure is logged and the rest go on. */
export async function applySlaActions(rows: SlaRow[], now: Date, effects: SlaEffects, warn: (line: string) => void = (line) => console.warn(line)): Promise<SlaAction[]> {
  const actions = slaActions(rows, now);
  for (const action of actions) {
    try {
      if (action.action === "remind") await effects.record(action.taskId, "sla.reminder", { gate: action.gate, dueAt: action.dueAt });
      else if (action.action === "escalate") await effects.record(action.taskId, "sla.escalated", { gate: action.gate, afterDays: action.afterSecs / 86_400, to: action.to });
      else await effects.archive(action.taskId, action.reason);
    } catch (error) {
      warn(`sla: ${action.action} of task ${action.taskId} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return actions;
}
