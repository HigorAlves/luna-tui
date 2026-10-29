// The ticket SLAs: how long a task may wait on you at a gate, how long a stage may run,
// created to closed, and the Jira due date (the end of that day where the Jira site lives). Pure: the clocks are computed from the task row,
// when its wait began, when its stage started and the targets in force; nothing is stored.
// The same `30m`/`4h`/`3d`/`off` durations luna.yaml and the env use are parsed here.
import { RUNNING, WAITING_ON_USER, type SlaClock, type TaskSla, type TaskState } from "@hardness/contracts";

import type { TaskRow } from "./task.ts";

const UNIT_SECS: Record<string, number> = { m: 60, h: 3600, d: 86_400 };

/** Seconds for `30m`, `4h`, `3d`; null for `off`; a bare number is seconds. Throws on anything else. */
export function parseDuration(value: string, what = "duration"): number | null {
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "off") return null;
  const match = /^(\d+)([mhd]?)$/.exec(trimmed);
  if (!match) throw new Error(`${what} must be a duration like 30m, 4h, 3d, or off, got "${value}"`);
  const n = Number(match[1]);
  if (n <= 0) throw new Error(`${what} must be a positive duration, got "${value}"`);
  return n * (UNIT_SECS[match[2]!] ?? 1);
}

/** The repo's targets after its luna.yaml, in seconds; null means no clock. */
export interface SlaTargets {
  gate: number | null;
  /** Keyed by running stage. */
  stage: Record<string, number>;
  cycle: number | null;
}

/** The machine-wide fallbacks from the env. */
export interface SlaDefaults {
  gate: number | null;
  cycle: number | null;
}

export const DEFAULT_GATE_SECS = 3600;

export interface SlaInput {
  task: Pick<TaskRow, "state" | "createdAt" | "jira">;
  /** When the task entered its current state (its latest transition), when known. */
  stateSince: Date | null;
  /** When the running stage run started, when one is running. */
  stageStartedAt: Date | null;
  /** The repo's own targets; `null` fields fall back to `defaults`. */
  targets: Partial<SlaTargets> | null;
  defaults: SlaDefaults;
}

/** Jira priority moves the gate target: Highest/High halve it, Lowest doubles it. */
export function gateFactor(priority: string | null | undefined): number {
  const p = (priority ?? "").toLowerCase();
  if (p === "highest" || p === "high") return 0.5;
  if (p === "lowest") return 2;
  return 1;
}

/** From 80% of a stage's target the clock warns. */
export const STAGE_WARN_SHARE = 0.8;

const clock = (since: Date, targetSecs: number, now: Date): SlaClock => {
  const dueAt = new Date(since.getTime() + targetSecs * 1000);
  return { dueAt: dueAt.toISOString(), overdue: dueAt.getTime() < now.getTime(), targetSecs };
};

/** The ticket's clocks right now; null when no clock applies at all. */
export function computeSla(input: SlaInput, now: Date): TaskSla | null {
  const { task, targets, defaults } = input;
  const state = task.state as TaskState;
  const gateTarget = targets?.gate === undefined ? defaults.gate : targets.gate;
  const cycleTarget = targets?.cycle === undefined ? defaults.cycle : targets.cycle;
  const gateSecs = gateTarget === null ? null : Math.round(gateTarget * gateFactor(task.jira?.priority));

  let gate: TaskSla["gate"] = null;
  if (WAITING_ON_USER.has(state) && gateSecs !== null) {
    const since = input.stateSince ?? task.createdAt;
    gate = { ...clock(since, gateSecs, now), since: since.toISOString(), state };
  }

  let stage: TaskSla["stage"] = null;
  const stageSecs = targets?.stage?.[state];
  if (RUNNING.has(state) && stageSecs !== undefined && stageSecs !== null) {
    const since = input.stageStartedAt ?? input.stateSince;
    if (since) {
      const c = clock(since, stageSecs, now);
      const elapsed = now.getTime() - since.getTime();
      stage = { ...c, stage: state, warn: elapsed >= stageSecs * 1000 * STAGE_WARN_SHARE };
    }
  }

  const cycle: TaskSla["cycle"] = cycleTarget !== null && state !== "closed" ? clock(task.createdAt, cycleTarget, now) : null;

  let jiraDue: TaskSla["jiraDue"] = null;
  const due = task.jira?.dueAt;
  if (due && state !== "closed") {
    // Jira stores a date: the day ends at 23:59:59 in the site's timezone (UTC until JiraWatch
    // has read it). The clock counts from the ticket's creation or its link time, whichever is later.
    const end = endOfDay(due, task.jira?.timeZone ?? null);
    if (end) {
      const linkedAt = task.jira?.linkedAt ? Date.parse(task.jira.linkedAt) : NaN;
      const from = Number.isNaN(linkedAt) ? task.createdAt.getTime() : Math.max(task.createdAt.getTime(), linkedAt);
      const targetSecs = Math.max(0, Math.round((end.getTime() - from) / 1000));
      jiraDue = { dueAt: end.toISOString(), overdue: end.getTime() < now.getTime(), targetSecs };
    }
  }

  if (!gate && !stage && !cycle && !jiraDue) return null;
  return { gate, stage, cycle, jiraDue };
}

/** The last instant of `YYYY-MM-DD` in an IANA timezone (UTC when none or unknown); a full timestamp is read as is; null when unreadable. */
export function endOfDay(due: string, timeZone: string | null): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) {
    const at = new Date(due);
    return Number.isNaN(at.getTime()) ? null : at;
  }
  const utc = Date.parse(`${due}T23:59:59.999Z`);
  if (!timeZone) return new Date(utc);
  // Shift by the zone's offset at that moment, then once more in case the first guess crossed a DST change.
  const guess = utc - offsetMs(timeZone, utc);
  return new Date(utc - offsetMs(timeZone, guess));
}

/** The zone's UTC offset in ms at `at`, from Intl; 0 for a zone Intl does not know. */
function offsetMs(timeZone: string, at: number): number {
  try {
    const part = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" }).formatToParts(new Date(at)).find((p) => p.type === "timeZoneName")?.value ?? "GMT";
    const match = /^GMT(?:([+-])(\d{2}):?(\d{2})?)?$/.exec(part);
    if (!match || !match[1]) return 0;
    const sign = match[1] === "-" ? -1 : 1;
    return sign * (Number(match[2]) * 60 + Number(match[3] ?? 0)) * 60_000;
  } catch {
    return 0;
  }
}

/** The flags a minute tick watches: any clock's `overdue`, the stage clock's `warn`. */
export function slaFlags(sla: TaskSla | null): string {
  if (!sla) return "";
  return [sla.gate?.overdue, sla.stage?.overdue, sla.stage?.warn, sla.cycle?.overdue, sla.jiraDue?.overdue].map((f) => (f ? "1" : "0")).join("");
}
