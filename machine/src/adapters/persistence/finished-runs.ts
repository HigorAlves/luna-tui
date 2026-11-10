// The finished stage runs of one repository, for the economy's import of what is already on disk (RFC 0007 §5): which pack and card each was, how it ended, on which runtime.
import type { DataSource } from "typeorm";

import type { PastRun } from "../../application/economy.ts";
import { packForState } from "../../domain/packs.ts";
import type { TaskState } from "@hardness/contracts";

type Row = { id: string; stage: TaskState; task_id: string; outcome: string | null; runtime: string | null };

/** Oldest first. A run still going, and one of a stage that runs no pack, are left out. */
export async function finishedRunsOf(db: DataSource, repoPath: string): Promise<PastRun[]> {
  const rows: Row[] = await db.query(
    `select r.id, r.stage, r.task_id, r.outcome, r.runtime from stage_runs r join tasks t on t.id = r.task_id
     where t.repo_path = $1 and r.ended_at is not null and r.outcome is not null order by r.started_at asc`,
    [repoPath],
  );
  return rows.flatMap((row) => {
    const pack = packForState(row.stage);
    return pack ? [{ runId: row.id, pack, cardId: row.task_id, outcome: row.outcome!, runtime: row.runtime }] : [];
  });
}
