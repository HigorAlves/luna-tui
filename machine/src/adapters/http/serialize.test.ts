import { describe, expect, it } from "vitest";

import type { TaskRow } from "../../domain/task.ts";
import { NO_RETRIES } from "../../domain/transition.ts";
import { toTask } from "./serialize.ts";

const row = (): TaskRow => ({
  id: "t1", title: "x", description: "", criteria: [], repoPath: null, source: null, route: "feature", branch: null, worktreePath: null,
  state: "draft", retries: { ...NO_RETRIES }, resumeTo: null, reason: null, queued: false, queuedAt: null, stateSince: null,
  diffAdded: null, diffRemoved: null, testsPassed: null, testsTotal: null, jira: null,
  createdAt: new Date(0), updatedAt: new Date(0),
});

describe("toTask", () => {
  it("carries spend and worked time when the caller knows them, null otherwise", () => {
    expect(toTask(row())).toMatchObject({ spentUsd: null, workedMs: null, diff: null, tests: null });
    expect(toTask(row(), { spentUsd: 0.5, workedMs: 180_000 })).toMatchObject({ spentUsd: 0.5, workedMs: 180_000 });
  });

  it("carries the Jira link from the column, or derives a bare one from an intake source, and the clocks the caller computed", () => {
    expect(toTask(row())).toMatchObject({ jira: null, sla: null });
    const link = { key: "PLAT-123", url: "https://acme.atlassian.net/browse/PLAT-123", issueType: "Bug", status: "In Progress", priority: "High", dueAt: "2026-10-31", syncedAt: "2026-10-28T12:00:00.000Z", blocked: null };
    expect(toTask({ ...row(), jira: link }).jira).toEqual(link);
    const source = { kind: "jira" as const, key: "PLAT-9", url: "https://acme.atlassian.net/browse/PLAT-9", issueType: "Story" };
    expect(toTask({ ...row(), source }).jira).toEqual({ key: "PLAT-9", url: source.url, issueType: "Story", status: null, priority: null, dueAt: null, syncedAt: null, blocked: null });
    const sla = { gate: { dueAt: "2026-10-28T13:00:00.000Z", overdue: false, targetSecs: 3600, since: "2026-10-28T12:00:00.000Z", state: "awaiting_approval" as const }, stage: null, cycle: null, jiraDue: null };
    expect(toTask(row(), null, sla).sla).toEqual(sla);
  });

  it("shapes the diff and the test count the task row carries", () => {
    const task = toTask({ ...row(), diffAdded: 142, diffRemoved: 18, testsPassed: 7, testsTotal: 9 });
    expect(task.diff).toEqual({ added: 142, removed: 18 });
    expect(task.tests).toEqual({ passed: 7, total: 9 });
  });
});
