// What a year of learning costs on disk, and the one place that gives it back (RFC 0006 wave 18).
//
// Disk, as measured: a card that runs end to end leaves 30 to 60 decision records of 2 to 12 KB (0.2 to 0.7 MB), about
// 50 KB of ground-truth files, and in the trace tool up to 200k characters of transcript for each of 15 to 25 runs
// (3 to 5 MB before the tool compresses it). At 5 cards a day a year of records is about 1 GB; at 20 a day about 4 GB,
// which is the default cap (`MACHINE_DECISIONS_MAX_MB`).
//
// The prune deletes only what the retention setting covers, only under `<stateDir>/decisions/` and
// `<stateDir>/ground-truth/`, and only a file it listed itself: `decisions/<pack>/<yyyy-mm-dd>/<id>.json` and
// `ground-truth/<kind>/<name>.json`. It never follows a symbolic link (a link is skipped and named in the log), never
// removes a record of a card that is still open, never a record younger than 7 days for the size cap, and nothing
// under `evidence/` (its own 180-day rule) or anywhere else.
import { lstat, readFile, readdir, rm, rmdir } from "node:fs/promises";
import { join } from "node:path";

import { DECISIONS_DIR } from "./decision-log.ts";

export const GROUND_TRUTH_DIR = "ground-truth";
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const FOLDER = /^[a-z0-9_]+$/;
const FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/;
const DAY_MS = 86_400_000;
const MB = 1024 * 1024;
/** The size cap never removes a record younger than this. */
const MIN_AGE_DAYS = 7;

export interface PruneInput {
  stateDir: string;
  /** 0 keeps everything by age. */
  retentionDays: number;
  /** 0 for no cap. */
  maxMb: number;
  /** Cards that are not closed: their records stay. */
  openTaskIds: ReadonlySet<string>;
  now: Date;
}

export interface PruneResult {
  records: number;
  truthFiles: number;
  freedBytes: number;
  skippedLinks: string[];
  /** The one line the machine logs. */
  line: string;
}

interface Listed {
  path: string;
  day: string;
  bytes: number;
  open: boolean;
  hasTruth: boolean;
}

async function plainDirs(parent: string, name: RegExp, links: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(parent).catch(() => [] as string[])) {
    if (!name.test(entry)) continue;
    const path = join(parent, entry);
    const stat = await lstat(path).catch(() => null);
    if (!stat) continue;
    if (stat.isSymbolicLink()) links.push(path);
    else if (stat.isDirectory()) out.push(path);
  }
  return out;
}

/** The record files this prune may touch, each read once for its card and its truth. */
async function listRecords(root: string, openTaskIds: ReadonlySet<string>, links: string[]): Promise<Listed[]> {
  const listed: Listed[] = [];
  for (const pack of await plainDirs(root, FOLDER, links)) {
    for (const dayDir of await plainDirs(pack, DAY, links)) {
      for (const name of await readdir(dayDir).catch(() => [] as string[])) {
        if (!FILE.test(name)) continue;
        const path = join(dayDir, name);
        const stat = await lstat(path).catch(() => null);
        if (!stat) continue;
        if (stat.isSymbolicLink()) {
          links.push(path);
          continue;
        }
        if (!stat.isFile()) continue;
        let taskId: unknown;
        let hasTruth = false;
        try {
          const parsed = JSON.parse(await readFile(path, "utf8")) as { taskId?: unknown; truth?: unknown };
          taskId = parsed.taskId;
          hasTruth = parsed.truth !== undefined && parsed.truth !== null;
        } catch {
          // An unreadable record is kept by the card rule only when we cannot tell: treat it as not open, with no truth.
        }
        listed.push({ path, day: dayDir.slice(-10), bytes: stat.size, open: typeof taskId === "string" && openTaskIds.has(taskId), hasTruth });
      }
    }
  }
  return listed;
}

export async function pruneLearning(input: PruneInput): Promise<PruneResult> {
  const links: string[] = [];
  const removedPaths = new Set<string>();
  let records = 0;
  let truthFiles = 0;
  let freed = 0;
  const drop = async (item: Listed): Promise<void> => {
    await rm(item.path, { force: true });
    removedPaths.add(item.path);
    records++;
    freed += item.bytes;
  };

  const decisions = join(input.stateDir, DECISIONS_DIR);
  let listed = await listRecords(decisions, input.openTaskIds, links);

  // By age: a day folder older than the retention loses its records, except those of an open card.
  if (input.retentionDays > 0) {
    const cutoff = new Date(input.now.getTime() - input.retentionDays * DAY_MS).toISOString().slice(0, 10);
    for (const item of listed) if (item.day < cutoff && !item.open) await drop(item);
    listed = listed.filter((item) => !removedPaths.has(item.path));
  }

  // By size: over the cap, records with no truth before records with one, oldest first, never a young one or an open card's.
  if (input.maxMb > 0) {
    let total = listed.reduce((sum, item) => sum + item.bytes, 0);
    const cap = input.maxMb * MB;
    if (total > cap) {
      const youngest = new Date(input.now.getTime() - MIN_AGE_DAYS * DAY_MS).toISOString().slice(0, 10);
      const order = listed.filter((item) => !item.open && item.day < youngest).sort((a, b) => Number(a.hasTruth) - Number(b.hasTruth) || a.day.localeCompare(b.day) || a.path.localeCompare(b.path));
      for (const item of order) {
        if (total <= cap) break;
        await drop(item);
        total -= item.bytes;
      }
    }
  }

  // Day folders and pack folders the prune emptied go with their last record; a folder with anything else stays.
  const emptied = new Set([...removedPaths].map((path) => path.slice(0, path.lastIndexOf("/"))));
  for (const dir of emptied) {
    await rmdir(dir).catch(() => {});
    await rmdir(dir.slice(0, dir.lastIndexOf("/"))).catch(() => {});
  }

  // Ground truth: a file whose mtime is older than the retention.
  if (input.retentionDays > 0) {
    const cutoffMs = input.now.getTime() - input.retentionDays * DAY_MS;
    for (const kind of await plainDirs(join(input.stateDir, GROUND_TRUTH_DIR), FOLDER, links)) {
      for (const name of await readdir(kind).catch(() => [] as string[])) {
        if (!FILE.test(name)) continue;
        const path = join(kind, name);
        const stat = await lstat(path).catch(() => null);
        if (!stat) continue;
        if (stat.isSymbolicLink()) {
          links.push(path);
          continue;
        }
        if (!stat.isFile() || stat.mtimeMs >= cutoffMs) continue;
        await rm(path, { force: true });
        truthFiles++;
        freed += stat.size;
      }
    }
  }

  const parts = [`${records} record(s)`, `${truthFiles} ground-truth file(s)`, `${(freed / MB).toFixed(1)} MB freed`];
  if (links.length > 0) parts.push(`skipped ${links.length} symbolic link(s): ${links.join(", ")}`);
  return { records, truthFiles, freedBytes: freed, skippedLinks: links, line: `prune: ${parts.join(", ")}` };
}

/** The cards a record may still be needed by: every task that is not closed or archived. */
export async function openTaskIdsOf(db: { query(sql: string): Promise<unknown> }): Promise<Set<string>> {
  const rows = (await db.query("select id from tasks where state not in ('closed', 'archived')")) as Array<{ id: string }>;
  return new Set(rows.map((row) => row.id));
}
