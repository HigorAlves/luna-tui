import { describe, expect, it } from "vitest";

import type { TaskRow } from "../../domain/task.ts";
import { NO_RETRIES } from "../../domain/transition.ts";
import { toTask } from "./serialize.ts";

const row = (): TaskRow => ({
  id: "t1", title: "x", description: "", criteria: [], repoPath: null, source: null, branch: null, worktreePath: null,
  state: "draft", retries: { ...NO_RETRIES }, resumeTo: null, reason: null, queued: false, queuedAt: null,
  createdAt: new Date(0), updatedAt: new Date(0),
});

describe("toTask", () => {
  it("carries what the ticket has spent when the caller knows it, null otherwise", () => {
    expect(toTask(row()).spentUsd).toBeNull();
    expect(toTask(row(), 0.5).spentUsd).toBe(0.5);
  });
});
