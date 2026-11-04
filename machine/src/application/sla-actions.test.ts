// What the minute tick does about a gate that has waited too long: remind once per gate entry, and
// archive a ticket left at Intake or Triage past `sla.archive`. The decisions are pure; the apply
// step records and archives through the pipeline.
import type { TaskSla, TaskState } from "@hardness/contracts";
import { describe, expect, it, vi } from "vitest";

import type { TaskRow } from "../domain/task.ts";
import { type SlaRow, applySlaActions, slaActions } from "./sla-actions.ts";

const DAY = 86_400_000;
const NOW = new Date("2026-11-10T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);

const row = (state: TaskState, waitedMs: number, over: Partial<SlaRow> = {}): SlaRow => {
  const stateSince = ago(waitedMs);
  const gate: TaskSla["gate"] = { dueAt: new Date(stateSince.getTime() + 2 * DAY).toISOString(), overdue: waitedMs > 2 * DAY, targetSecs: 2 * 86_400, since: stateSince.toISOString(), state: state as never };
  return { task: { id: "t1", state, stateSince } as unknown as TaskRow, sla: { gate, stage: null, cycle: null, jiraDue: null }, targets: { gate: 2 * 86_400, archive: 5 * 86_400 }, lastReminderAt: null, ...over };
};

describe("slaActions", () => {
  it("reminds once a gate is overdue: not before, and not again while the task has not moved", () => {
    expect(slaActions([row("awaiting_answers", 1 * DAY)], NOW)).toEqual([]);
    const [due] = slaActions([row("awaiting_answers", 3 * DAY)], NOW);
    expect(due).toMatchObject({ taskId: "t1", action: "remind", gate: "awaiting_answers" });
    expect(slaActions([row("awaiting_answers", 3 * DAY, { lastReminderAt: ago(1 * DAY) })], NOW)).toEqual([]);
    // A reminder from before the task entered this gate does not count.
    expect(slaActions([row("awaiting_answers", 3 * DAY, { lastReminderAt: ago(4 * DAY) })], NOW)).toHaveLength(1);
  });

  it("archives a ticket left at intake or triage gates past sla.archive, instead of reminding", () => {
    expect(slaActions([row("awaiting_answers", 6 * DAY)], NOW)).toEqual([{ taskId: "t1", action: "archive", reason: "sla_expired", gate: "awaiting_answers" }]);
    expect(slaActions([row("awaiting_setup", 6 * DAY)], NOW)).toEqual([expect.objectContaining({ action: "archive" })]);
  });

  it("never archives a later gate, or without a target: it only reminds", () => {
    expect(slaActions([row("awaiting_approval", 6 * DAY)], NOW)).toEqual([expect.objectContaining({ action: "remind", gate: "awaiting_approval" })]);
    expect(slaActions([row("awaiting_answers", 6 * DAY, { targets: { gate: 2 * 86_400 } })], NOW)).toEqual([expect.objectContaining({ action: "remind" })]);
    expect(slaActions([row("awaiting_answers", 6 * DAY, { targets: { gate: 2 * 86_400, archive: null } })], NOW)).toEqual([expect.objectContaining({ action: "remind" })]);
  });

  it("says nothing for a task with no gate clock and none at a gate", () => {
    expect(slaActions([row("implementing", 6 * DAY, { sla: null })], NOW)).toEqual([]);
  });
});

describe("applySlaActions", () => {
  it("records a reminder with its gate and due time, and archives with sla_expired", async () => {
    const record = vi.fn(async () => {});
    const archive = vi.fn(async () => ({}) as TaskRow);
    const due = row("awaiting_approval", 3 * DAY);
    const gone = { ...row("awaiting_answers", 6 * DAY), task: { id: "t2", state: "awaiting_answers", stateSince: ago(6 * DAY) } as unknown as TaskRow };
    await applySlaActions([due, gone], NOW, { record, archive });
    expect(record).toHaveBeenCalledWith("t1", "sla.reminder", { gate: "awaiting_approval", dueAt: due.sla!.gate!.dueAt });
    expect(archive).toHaveBeenCalledWith("t2", "sla_expired");
  });

  it("goes on after one action fails", async () => {
    const record = vi.fn(async () => {
      throw new Error("db down");
    });
    const archive = vi.fn(async () => ({}) as TaskRow);
    const gone = { ...row("awaiting_answers", 6 * DAY), task: { id: "t2", state: "awaiting_answers", stateSince: ago(6 * DAY) } as unknown as TaskRow };
    await applySlaActions([row("awaiting_approval", 3 * DAY), gone], NOW, { record, archive }, () => {});
    expect(archive).toHaveBeenCalledWith("t2", "sla_expired");
  });
});
