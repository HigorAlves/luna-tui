import { describe, expect, it } from "vitest";

import type { TaskRow } from "../../domain/task.ts";
import { NO_RETRIES } from "../../domain/transition.ts";
import { toTask } from "./serialize.ts";

const row = (): TaskRow => ({
  id: "t1", title: "x", description: "", criteria: [], repoPath: null, source: null, branch: null, worktreePath: null,
  state: "draft", retries: { ...NO_RETRIES }, resumeTo: null, reason: null, queued: false, queuedAt: null,
  diffAdded: null, diffRemoved: null, testsPassed: null, testsTotal: null,
  createdAt: new Date(0), updatedAt: new Date(0),
});

describe("toTask", () => {
  it("carries spend and worked time when the caller knows them, null otherwise", () => {
    expect(toTask(row())).toMatchObject({ spentUsd: null, workedMs: null, diff: null, tests: null });
    expect(toTask(row(), { spentUsd: 0.5, workedMs: 180_000 })).toMatchObject({ spentUsd: 0.5, workedMs: 180_000 });
  });

  it("shapes the diff and the test count the task row carries", () => {
    const task = toTask({ ...row(), diffAdded: 142, diffRemoved: 18, testsPassed: 7, testsTotal: 9 });
    expect(task.diff).toEqual({ added: 142, removed: 18 });
    expect(task.tests).toEqual({ passed: 7, total: 9 });
  });
});
