// The finished stage runs of one repository, for the economy's import of what is already on disk (RFC 0007 §5): which pack and card each was, how it ended, on which runtime.
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { PACKS, type PackId } from "@hardness/contracts";
import type { DataSource } from "typeorm";

import type { PastRun } from "../../application/economy.ts";
import { readRegularFile } from "../fs/bounded.ts";
import { packForState } from "../../domain/packs.ts";
import type { TaskState } from "@hardness/contracts";

type Row = { id: string; stage: TaskState; task_id: string; outcome: string | null; runtime: string | null };

/** The most sub-run folders one import reads. */
const SUB_RUNS_MAX = 5000;
/** A stage.json is read only as far as its `pack` field is needed; a larger one is skipped. */
const STAGE_JSON_CAP = 16 * 1024 * 1024;

/** The pack a run folder ran, from its `in/stage.json`; null when the file is missing, too large, not JSON or names no pack. */
async function packOfFolder(stateDir: string, folder: string): Promise<PackId | null> {
  try {
    const pack = (JSON.parse(await readRegularFile(join(stateDir, "runs", folder, "in", "stage.json"), STAGE_JSON_CAP)) as { pack?: unknown }).pack;
    return typeof pack === "string" && Object.hasOwn(PACKS, pack) ? (pack as PackId) : null;
  } catch {
    return null;
  }
}

/**
 * Oldest first. A run still going, and one of a stage that runs no pack, are left out.
 * With `stateDir`, the sub-run folders of a finished run (`<runId>-<suffix>`: the planner's, the video's, a ship fix's) follow it, each under the pack its own `in/stage.json` names, with the run's card and outcome; a folder whose pack cannot be known is skipped.
 * The import folds a folder's events as they are on disk: a Build's containers share one folder, so it holds the last container's events only.
 */
export async function finishedRunsOf(db: DataSource, repoPath: string, stateDir?: string): Promise<PastRun[]> {
  const rows: Row[] = await db.query(
    `select r.id, r.stage, r.task_id, r.outcome, r.runtime from stage_runs r join tasks t on t.id = r.task_id
     where t.repo_path = $1 and r.ended_at is not null and r.outcome is not null order by r.started_at asc`,
    [repoPath],
  );
  let folders: string[] = [];
  if (stateDir) {
    try {
      folders = (await readdir(join(stateDir, "runs"))).slice(0, SUB_RUNS_MAX);
    } catch {
      folders = [];
    }
  }
  const out: PastRun[] = [];
  for (const row of rows) {
    const pack = packForState(row.stage);
    if (pack) out.push({ runId: row.id, pack, cardId: row.task_id, outcome: row.outcome!, runtime: row.runtime });
    for (const name of folders.filter((f) => f.startsWith(`${row.id}-`))) {
      const sub = await packOfFolder(stateDir!, name);
      if (sub) out.push({ runId: name, pack: sub, cardId: row.task_id, outcome: row.outcome!, runtime: row.runtime });
    }
  }
  return out;
}
