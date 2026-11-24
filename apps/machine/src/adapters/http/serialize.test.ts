import { describe, expect, it } from "vitest";

import type { TaskRow } from "../../domain/task.ts";
import { NO_RETRIES } from "../../domain/transition.ts";
import { toTask } from "./serialize.ts";

const row = (): TaskRow => ({
  id: "t1", title: "x", description: "", criteria: [], repoPath: null, source: null, route: "feature", branch: null, worktreePath: null,
  state: "draft", retries: { ...NO_RETRIES }, resumeTo: null, reason: null, archiveReason: null, queued: false, queuedAt: null, stateSince: null, idempotencyKey: null, requestHash: null, stages: {}, seq: "1",
  diffAdded: null, diffRemoved: null, testsPassed: null, testsTotal: null, jira: null, classification: null, record: null, evidence: null,
  createdAt: new Date(0), updatedAt: new Date(0),
});

describe("toTask", () => {
  it("shows an escalated card in the column of the stage it resumes at, and in Build when none is recorded", () => {
    expect(toTask({ ...row(), state: "escalated", resumeTo: "delivering" }).column).toBe("Verify");
    expect(toTask({ ...row(), state: "escalated", resumeTo: "awaiting_ship" }).column).toBe("Ship");
    expect(toTask({ ...row(), state: "escalated", resumeTo: null }).column).toBe("Build");
  });

  it("carries spend and worked time when the caller knows them, null otherwise", () => {
    expect(toTask(row())).toMatchObject({ spentUsd: null, workedMs: null, diff: null, tests: null });
    expect(toTask(row(), { spentUsd: 0.5, workedMs: 180_000 })).toMatchObject({ spentUsd: 0.5, workedMs: 180_000 });
  });

  it("carries the Jira link from the column, or derives a bare one from an intake source, and the clocks the caller computed", () => {
    expect(toTask(row())).toMatchObject({ jira: null, sla: null });
    const link = { key: "PLAT-123", url: "https://acme.atlassian.net/browse/PLAT-123", issueType: "Bug", status: "In Progress", priority: "High", dueAt: "2026-10-31", syncedAt: "2026-10-28T12:00:00.000Z", blocked: null };
    expect(toTask({ ...row(), jira: link }).jira).toEqual(link);
    const source = { kind: "jira" as const, key: "PLAT-9", url: "https://acme.atlassian.net/browse/PLAT-9", issueType: "Story" };
    expect(toTask({ ...row(), source }).jira).toEqual({ key: "PLAT-9", url: source.url, issueType: "Story", status: null, priority: null, dueAt: null, syncedAt: null, blocked: null, linkedAt: null, timeZone: null });
    const sla = { gate: { dueAt: "2026-10-28T13:00:00.000Z", overdue: false, targetSecs: 3600, since: "2026-10-28T12:00:00.000Z", state: "awaiting_approval" as const }, stage: null, cycle: null, jiraDue: null };
    expect(toTask(row(), null, sla).sla).toEqual(sla);
  });

  it("shapes the diff and the test count the task row carries", () => {
    const task = toTask({ ...row(), diffAdded: 142, diffRemoved: 18, testsPassed: 7, testsTotal: 9 });
    expect(task.diff).toEqual({ added: 142, removed: 18 });
    expect(task.tests).toEqual({ passed: 7, total: 9 });
  });

  it("carries the triage record and the evidence pack, null when the task has none", () => {
    expect(toTask(row())).toMatchObject({ record: null, evidence: null });
    const record = { source: "github", kind: "bug", goal: "g", size: "small", urgency: "normal", risk: "low" as const, signals: {}, qa: [], decision: "plan" as const, reason: "r", at: "2026-11-03T12:00:00.000Z", model: "m" };
    const evidence = { summary: "s", format: "text" as const, scenarios: [], findings: [], outOfMap: [], risk: "none" as const, rollback: "revert", howToVerify: "run it", commitSha: "abc", media: [], at: "2026-11-03T12:00:00.000Z" };
    expect(toTask({ ...row(), record, evidence })).toMatchObject({ record, evidence });
  });

  it("carries the row's sequence number as a number", () => {
    expect(toTask({ ...row(), seq: "9007199254740" }).seq).toBe(9007199254740);
  });
});

describe("toTask at the states that hold a stage or a gate", () => {
  it("counts awaiting_ship and reviewing_memory as waiting on you only with an open gate, else as running", () => {
    const gate = { state: "awaiting_ship" as const, requested: {} };
    for (const state of ["awaiting_ship", "reviewing_memory"] as const) {
      expect(toTask({ ...row(), state }, null, null, { lastRun: null, gate: null })).toMatchObject({ waitingOnYou: false, running: true });
      expect(toTask({ ...row(), state, queued: true }, null, null, { lastRun: null, gate: null })).toMatchObject({ waitingOnYou: false, running: false });
      expect(toTask({ ...row(), state }, null, null, { lastRun: null, gate: { ...gate, state } })).toMatchObject({ waitingOnYou: true, running: false });
    }
    expect(toTask({ ...row(), state: "awaiting_approval" })).toMatchObject({ waitingOnYou: true, running: false });
    expect(toTask({ ...row(), state: "shipping" })).toMatchObject({ waitingOnYou: false, running: true });
  });
});

describe("toEvent names", () => {
  const row = (kind: string, payload: Record<string, unknown>) => ({ id: "5", taskId: "t", stageRunId: null, kind, payload, at: new Date("2026-11-05T00:00:00Z") });

  it("sets the diagram's names on a row that has one, and leaves a row the diagram has no name for exactly as it was", async () => {
    const { toEvent } = await import("./serialize.ts");
    expect(toEvent(row("task.shipped", { number: 1 }))).toEqual({ id: "5", taskId: "t", kind: "task.shipped", payload: { number: 1 }, at: "2026-11-05T00:00:00.000Z", names: ["ship.merged"] });
    expect(toEvent(row("stage.note", { note: "x" }))).toEqual({ id: "5", taskId: "t", kind: "stage.note", payload: { note: "x" }, at: "2026-11-05T00:00:00.000Z" });
  });
});
