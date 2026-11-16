// The repo signals read a repo's stage runs, the loop guard's stops and the ledger's cost, per pack, from a date on.
import type { DataSource } from "typeorm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { EconomyStore } from "../../application/economy.ts";
import { NO_RETRIES } from "../../domain/transition.ts";
import { freshTestDatabase } from "../../test/database.ts";
import { pgRepoSignals } from "./repo-signals.ts";
import { StageRunEntity, TaskEntity } from "./schemas.ts";

let db: DataSource;
beforeAll(async () => {
  db = await freshTestDatabase();
});
afterAll(async () => {
  await db.destroy();
});
beforeEach(async () => {
  await db.query("truncate tasks cascade");
});

const DAY = 86_400_000;
const save = (repoPath: string) => db.getRepository(TaskEntity).save({ title: "x", description: "", criteria: [], repoPath, branch: null, worktreePath: null, state: "triage", retries: { ...NO_RETRIES }, resumeTo: null, reason: null });
const stage = (taskId: string, stageName: "triage" | "setup", outcome: string, costUsd: string | null, ago = 0) =>
  db.getRepository(StageRunEntity).save({ taskId, stage: stageName, attempt: 1, status: outcome === "pass" ? "passed" : "failed", outcome, costUsd, startedAt: new Date(Date.now() - ago * DAY) });

const economy = (guard: unknown[], ledger: unknown[]) => ({ guard: async () => guard, ledger: async () => ledger }) as unknown as EconomyStore;

describe("pgRepoSignals", () => {
  it("counts a pack's runs, escalations, stops and cost in the repo since the date", async () => {
    const mine = await save("/r/app");
    const other = await save("/r/other");
    await stage(mine.id, "triage", "pass", "1.0000");
    await stage(mine.id, "triage", "escalated", "2.0000");
    await stage(mine.id, "setup", "pass", "0.5000");
    await stage(mine.id, "setup", "pass", "9.0000", 40);
    await stage(other.id, "setup", "escalated", "7.0000");
    const since = new Date(Date.now() - 30 * DAY);
    const at = new Date().toISOString();
    const old = new Date(Date.now() - 40 * DAY).toISOString();
    const signals = pgRepoSignals(
      db,
      economy(
        [
          { at, runId: "a", pack: "setup", action: "stop", calls: 9 },
          { at, runId: "b", pack: "setup", action: "gate", calls: 3 },
          { at: old, runId: "c", pack: "setup", action: "stop", calls: 9 },
        ],
        [{ at, runId: "a", pack: "loop_judge", card: "c", kind: "overhead", effective: 0, tokens: null, costUsd: 0.25 }],
      ),
    );
    const got = await signals.forRepo("/r/app", since);
    expect(got.triage).toEqual({ runs: 2, escalations: 1, stuck: 0, costUsd: 3 });
    expect(got.setup).toEqual({ runs: 1, escalations: 0, stuck: 1, costUsd: 0.5 });
    expect(got.loop_judge).toEqual({ runs: 0, escalations: 0, stuck: 0, costUsd: 0.25 });
  });

  it("is empty for a repo with no runs", async () => {
    expect(await pgRepoSignals(db, economy([], [])).forRepo("/r/none", new Date(0))).toEqual({});
  });
});
