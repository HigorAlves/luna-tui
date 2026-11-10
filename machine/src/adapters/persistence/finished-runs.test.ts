import type { DataSource } from "typeorm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { freshTestDatabase } from "../../test/database.ts";
import { finishedRunsOf } from "./finished-runs.ts";
import { PgTaskStore } from "./task-store.ts";

let db: DataSource;
beforeAll(async () => void (db = await freshTestDatabase()));
afterAll(() => db.destroy());

describe("finishedRunsOf", () => {
  it("lists a repository's ended runs oldest first, with their pack, card, outcome and runtime", async () => {
    const store = new PgTaskStore(db);
    const mine = await store.createTask({ title: "a", description: "", criteria: [], repoPath: "/r/mine" } as never);
    const other = await store.createTask({ title: "b", description: "", criteria: [], repoPath: "/r/other" } as never);
    const first = await store.insertStageRun({ taskId: mine.id, stage: "implementing", attempt: 1 });
    await store.updateStageRun(first, { status: "passed", outcome: "pass", runtime: "eve", ended: true } as never);
    const second = await store.insertStageRun({ taskId: mine.id, stage: "verifying", attempt: 1 });
    await store.updateStageRun(second, { status: "failed", outcome: "fail", runtime: "claude", ended: true } as never);
    await store.insertStageRun({ taskId: mine.id, stage: "implementing", attempt: 2 });
    const foreign = await store.insertStageRun({ taskId: other.id, stage: "implementing", attempt: 1 });
    await store.updateStageRun(foreign, { status: "passed", outcome: "pass", ended: true } as never);
    expect(await finishedRunsOf(db, "/r/mine")).toEqual([
      { runId: first, pack: "implementing", cardId: mine.id, outcome: "pass", runtime: "eve" },
      { runId: second, pack: "verifying", cardId: mine.id, outcome: "fail", runtime: "claude" },
    ]);
  });
});
