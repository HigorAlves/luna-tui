import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

  it("adds the sub-run folders of a finished run, under the pack their stage.json names, and skips the ones it cannot name", async () => {
    const store = new PgTaskStore(db);
    const task = await store.createTask({ title: "a", description: "", criteria: [], repoPath: "/r/sub" } as never);
    const run = await store.insertStageRun({ taskId: task.id, stage: "test_design", attempt: 1 });
    await store.updateStageRun(run, { status: "passed", outcome: "pass", runtime: "claude", ended: true } as never);
    const live = await store.insertStageRun({ taskId: task.id, stage: "implementing", attempt: 1 });
    const stateDir = mkdtempSync(join(tmpdir(), "finished-"));
    const folder = (name: string, stage: unknown) => {
      mkdirSync(join(stateDir, "runs", name, "in"), { recursive: true });
      if (stage !== null) writeFileSync(join(stateDir, "runs", name, "in", "stage.json"), typeof stage === "string" ? stage : JSON.stringify(stage));
    };
    folder(`${run}-codemap`, { pack: "code_map" });
    folder(`${run}-unknown`, { pack: "not_a_pack" });
    folder(`${run}-nofile`, null);
    folder(`${run}-broken`, "{not json");
    folder(`${live}-codemap`, { pack: "code_map" });
    folder(`${run}x-codemap`, { pack: "code_map" });
    expect(await finishedRunsOf(db, "/r/sub", stateDir)).toEqual([
      { runId: run, pack: "test_design", cardId: task.id, outcome: "pass", runtime: "claude" },
      { runId: `${run}-codemap`, pack: "code_map", cardId: task.id, outcome: "pass", runtime: "claude" },
    ]);
  });
});
