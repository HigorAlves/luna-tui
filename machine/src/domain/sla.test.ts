import { describe, expect, it } from "vitest";

import { NO_RETRIES } from "./transition.ts";
import type { TaskRow } from "./task.ts";
import { computeSla, gateFactor, parseDuration, slaFlags } from "./sla.ts";

const NOW = new Date("2026-10-28T12:00:00Z");
const task = (over: Partial<TaskRow> = {}): TaskRow => ({
  id: "t1", title: "x", description: "", criteria: [], repoPath: null, source: null, route: "feature", branch: null, worktreePath: null,
  state: "awaiting_approval", retries: { ...NO_RETRIES }, resumeTo: null, reason: null, queued: false, queuedAt: null,
  diffAdded: null, diffRemoved: null, testsPassed: null, testsTotal: null, jira: null,
  createdAt: new Date("2026-10-27T12:00:00Z"), updatedAt: NOW, ...over,
});
const defaults = { gate: 3600, cycle: null };

describe("parseDuration", () => {
  it("reads minutes, hours, days, bare seconds and off", () => {
    expect(parseDuration("30m")).toBe(1800);
    expect(parseDuration("4h")).toBe(14_400);
    expect(parseDuration("3d")).toBe(259_200);
    expect(parseDuration("90")).toBe(90);
    expect(parseDuration("off")).toBeNull();
    expect(() => parseDuration("soon", "MACHINE_SLA_GATE")).toThrow(/MACHINE_SLA_GATE must be a duration/);
    expect(() => parseDuration("0h")).toThrow(/positive/);
  });
});

describe("computeSla", () => {
  it("runs the gate clock from the moment the task started waiting, with the repo's target over the machine's", () => {
    const since = new Date("2026-10-28T11:30:00Z");
    const sla = computeSla({ task: task(), stateSince: since, stageStartedAt: null, targets: null, defaults }, NOW);
    expect(sla?.gate).toEqual({ dueAt: "2026-10-28T12:30:00.000Z", overdue: false, targetSecs: 3600, since: since.toISOString(), state: "awaiting_approval" });
    const tight = computeSla({ task: task(), stateSince: since, stageStartedAt: null, targets: { gate: 600 }, defaults }, NOW);
    expect(tight?.gate).toMatchObject({ dueAt: "2026-10-28T11:40:00.000Z", overdue: true, targetSecs: 600 });
    expect(computeSla({ task: task(), stateSince: since, stageStartedAt: null, targets: { gate: null }, defaults }, NOW)).toBeNull();
    expect(computeSla({ task: task({ state: "implementing" }), stateSince: since, stageStartedAt: since, targets: null, defaults }, NOW)).toBeNull();
  });

  it("tightens the gate for a High or Highest Jira priority and relaxes it for Lowest", () => {
    expect(gateFactor("Highest")).toBe(0.5);
    expect(gateFactor("high")).toBe(0.5);
    expect(gateFactor("Lowest")).toBe(2);
    expect(gateFactor("Medium")).toBe(1);
    expect(gateFactor(null)).toBe(1);
    const jira = { key: "PLAT-1", url: "u", issueType: "Bug", status: null, priority: "High", dueAt: null, syncedAt: null, blocked: null };
    const sla = computeSla({ task: task({ jira }), stateSince: new Date("2026-10-28T11:00:00Z"), stageStartedAt: null, targets: null, defaults }, NOW);
    expect(sla?.gate).toMatchObject({ targetSecs: 1800, dueAt: "2026-10-28T11:30:00.000Z", overdue: true });
  });

  it("runs the stage clock only for a running stage the repo named, warning from 80% of the target", () => {
    const started = new Date("2026-10-28T08:40:00Z");
    const targets = { stage: { implementing: 14_400 } };
    const sla = computeSla({ task: task({ state: "implementing" }), stateSince: null, stageStartedAt: started, targets, defaults }, NOW);
    expect(sla?.stage).toEqual({ dueAt: "2026-10-28T12:40:00.000Z", overdue: false, targetSecs: 14_400, stage: "implementing", warn: true });
    const fresh = computeSla({ task: task({ state: "implementing" }), stateSince: null, stageStartedAt: new Date("2026-10-28T11:00:00Z"), targets, defaults }, NOW);
    expect(fresh?.stage).toMatchObject({ warn: false, overdue: false });
    expect(computeSla({ task: task({ state: "verifying" }), stateSince: null, stageStartedAt: started, targets, defaults }, NOW)).toBeNull();
    expect(computeSla({ task: task({ state: "implementing" }), stateSince: null, stageStartedAt: null, targets, defaults }, NOW)).toBeNull();
  });

  it("runs the cycle clock from creation while open, and the Jira due date to the end of its day", () => {
    const jira = { key: "PLAT-1", url: "u", issueType: null, status: null, priority: null, dueAt: "2026-10-27", syncedAt: null, blocked: null };
    const sla = computeSla({ task: task({ state: "implementing", jira }), stateSince: null, stageStartedAt: null, targets: { cycle: 86_400 }, defaults }, NOW);
    expect(sla?.cycle).toEqual({ dueAt: "2026-10-28T12:00:00.000Z", overdue: false, targetSecs: 86_400 });
    expect(sla?.jiraDue).toEqual({ dueAt: "2026-10-27T23:59:59.999Z", overdue: true, targetSecs: 43_200 });
    expect(computeSla({ task: task({ state: "closed", jira }), stateSince: null, stageStartedAt: null, targets: { cycle: 86_400 }, defaults }, NOW)).toBeNull();
    expect(slaFlags(sla)).toBe("00001");
    expect(slaFlags(null)).toBe("");
  });
});
