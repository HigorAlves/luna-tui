// Bounds event/stage-run growth for a long-lived machine: closed tasks keep their row
// (so Done stays visible), but their verbose history is trimmed once it's old enough
// that nobody's going to scroll back to it.
import { rm } from "node:fs/promises";
import { join } from "node:path";

import type { DataSource } from "typeorm";

export interface PruneResult {
  events: number;
  stageRuns: number;
}

/** Also removes `<stateDir>/runs/<runId>/` (ingested artifacts, transcripts) for each pruned stage run. */
export async function pruneOldRuns(db: DataSource, retentionDays: number, stateDir?: string): Promise<PruneResult> {
  if (retentionDays <= 0) return { events: 0, stageRuns: 0 };

  const prunedRunIds: string[] = [];
  const result = await db.transaction(async (tx) => {
    const cutoffCondition = `task_id in (
      select id from tasks where state = 'closed' and updated_at < now() - make_interval(days => $1)
    )`;
    // TypeORM's query() for a Postgres DELETE ... RETURNING resolves to a [rows, rowCount]
    // tuple, not just the rows array — destructure, don't just read .length on the result.
    // Neither delete has a foreign key to the other (both only reference `tasks`), so they
    // can run concurrently inside the same transaction instead of paying two round trips.
    const [[, eventCount], [stageRunRows, stageRunCount]] = (await Promise.all([
      tx.query(`delete from events where ${cutoffCondition} returning id`, [retentionDays]),
      tx.query(`delete from stage_runs where ${cutoffCondition} returning id`, [retentionDays]),
    ])) as [[unknown[], number], [{ id: string }[], number]];
    prunedRunIds.push(...stageRunRows.map((row) => row.id));
    return { events: eventCount, stageRuns: stageRunCount };
  });
  if (stateDir) {
    await Promise.all(prunedRunIds.map((id) => rm(join(stateDir, "runs", id), { recursive: true, force: true })));
    if (prunedRunIds.length > 0) console.log(`pruned ${prunedRunIds.length} run folder(s)`);
  }
  return result;
}
