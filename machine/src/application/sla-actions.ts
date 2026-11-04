// What the minute tick does about a gate that has waited too long (RFC 0005): remind once per
// gate entry, and archive a ticket left at an intake gate (setup, triage's questions) past
// `sla.archive`. `slaActions` only decides, from the clocks and what was already said; the apply
// step records and archives. A later gate (the plan, the tests, ship) is only ever reminded of:
// work that has been approved is never thrown away by a clock.
import type { ArchiveReason, TaskSla, TaskState } from "@hardness/contracts";

import type { SlaTargets } from "../domain/sla.ts";
import type { TaskRow } from "../domain/task.ts";

export type SlaAction =
  | { taskId: string; action: "remind"; gate: TaskState; dueAt: string }
  | { taskId: string; action: "archive"; reason: Extract<ArchiveReason, "sla_expired">; gate: TaskState };

/** The gates a ticket may be archived from: before anything was approved. */
export const AUTO_ARCHIVE_GATES: ReadonlySet<TaskState> = new Set<TaskState>(["awaiting_setup", "awaiting_answers"]);

export interface SlaRow {
  task: TaskRow;
  sla: TaskSla | null;
  /** The repo's own targets. */
  targets: Partial<SlaTargets>;
  /** When the last `sla.reminder` event of this task was recorded; null when none. */
  lastReminderAt: Date | null;
}

export function slaActions(rows: SlaRow[], now: Date): SlaAction[] {
  const actions: SlaAction[] = [];
  for (const { task, sla, targets, lastReminderAt } of rows) {
    const gate = task.state as TaskState;
    const since = task.stateSince ?? task.createdAt;
    const archiveAfter = targets.archive;
    if (AUTO_ARCHIVE_GATES.has(gate) && typeof archiveAfter === "number" && since && now.getTime() - since.getTime() >= archiveAfter * 1000) {
      actions.push({ taskId: task.id, action: "archive", reason: "sla_expired", gate });
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
  archive(taskId: string, reason: "sla_expired"): Promise<TaskRow>;
}

/** Does what `slaActions` decided; one failure is logged and the rest go on. */
export async function applySlaActions(rows: SlaRow[], now: Date, effects: SlaEffects, warn: (line: string) => void = (line) => console.warn(line)): Promise<SlaAction[]> {
  const actions = slaActions(rows, now);
  for (const action of actions) {
    try {
      if (action.action === "remind") await effects.record(action.taskId, "sla.reminder", { gate: action.gate, dueAt: action.dueAt });
      else await effects.archive(action.taskId, action.reason);
    } catch (error) {
      warn(`sla: ${action.action} of task ${action.taskId} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return actions;
}
