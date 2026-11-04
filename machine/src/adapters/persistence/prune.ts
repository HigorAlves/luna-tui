// Bounds event/stage-run growth for a long-lived machine: closed tasks keep their row
// (so Done stays visible), but their verbose history is trimmed once it's old enough
// that nobody's going to scroll back to it.
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import type { DataSource } from "typeorm";

export interface PruneResult {
  events: number;
  stageRuns: number;
}

/** Also removes `<stateDir>/runs/<runId>/` (ingested artifacts, transcripts) for each pruned stage run, and the sub-run folders named `<runId>-*`. */
export async function pruneOldRuns(db: DataSource, retentionDays: number, stateDir?: string): Promise<PruneResult> {
  if (retentionDays <= 0) return { events: 0, stageRuns: 0 };

  const prunedRunIds: string[] = [];
  const result = await db.transaction(async (tx) => {
    const cutoffCondition = `task_id in (
      select id from tasks where state in ('closed', 'archived') and updated_at < now() - make_interval(days => $1)
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
    // A run's own folder, and the sub-run folders derived from its id (`<id>-plan`, `<id>-tests-1`).
    const runsDir = join(stateDir, "runs");
    const names = prunedRunIds.length > 0 ? await readdir(runsDir).catch(() => [] as string[]) : [];
    const doomed = new Set(prunedRunIds);
    const derived = names.filter((name) => prunedRunIds.some((id) => name.startsWith(`${id}-`)));
    await Promise.all([...doomed, ...derived].map((name) => rm(join(runsDir, name), { recursive: true, force: true })));
    if (prunedRunIds.length > 0) console.log(`pruned ${prunedRunIds.length} run folder(s)`);
  }
  return result;
}

/** Deletes the `pack_runs` rows (one per `POST /runs` call) started more than `days` ago: the
 *  same window as the stage runs' history. 0 disables it. Returns how many went. */
export async function prunePackRuns(db: DataSource, days: number): Promise<number> {
  if (days <= 0) return 0;
  const [, count] = (await db.query("delete from pack_runs where started_at < now() - make_interval(days => $1) returning id", [days])) as [unknown[], number];
  return count;
}

/** How long a deleted task's tombstone is kept for `GET /events?since=` to replay its deletion. */
export const TOMBSTONE_RETENTION_DAYS = 30;

/** Deletes the tombstones of tasks deleted more than `days` ago: a client that has been away
 *  longer re-reads `GET /tasks` instead of replaying. Returns how many went. */
export async function pruneTombstones(db: DataSource, days: number = TOMBSTONE_RETENTION_DAYS): Promise<number> {
  const [, count] = (await db.query("delete from task_tombstones where deleted_at < now() - make_interval(days => $1) returning id", [days])) as [unknown[], number];
  return count;
}
