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
/** A temporary file of a writer that died: `<id>.json.<8 hex>.tmp` (the decision log) or `.<name>.<uuid>.tmp` (a truth file), removed after a day. */
const TEMP = /^(?:[A-Za-z0-9][A-Za-z0-9._-]*\.json\.[0-9a-f]{8}|\.[A-Za-z0-9][A-Za-z0-9._-]*\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.tmp$/;

export interface PruneInput {
  stateDir: string;
  /** 0 keeps everything by age. */
  retentionDays: number;
  /** 0 for no cap. */
  maxMb: number;
  /** Cards that are not closed: their records stay. */
  openTaskIds: ReadonlySet<string>;
  now: Date;
  /** Called once the records are listed and before any is removed: a test's window for a record that changes in between. */
  afterListing?: () => Promise<void>;
}

export interface PruneResult {
  records: number;
  truthFiles: number;
  freedBytes: number;
  skippedLinks: string[];
  /** The one line the machine logs. */
  line: string;
  /** One line when the size cap cannot be met because what is left cannot be pruned (open cards, young records, a person's truth, ground truth); null otherwise. */
  warning: string | null;
}

interface Listed {
  path: string;
  day: string;
  bytes: number;
  open: boolean;
  hasTruth: boolean;
  /** A person's word is on the record: it is never removed for size. */
  person: boolean;
}

/** Whether a stored record carries a person's truth: its own kind or any entry of its history. */
function personTruth(truth: unknown): boolean {
  if (truth === null || typeof truth !== "object") return false;
  const { kind, history, kinds } = truth as { kind?: unknown; history?: unknown; kinds?: unknown };
  return kind === "person" || (Array.isArray(history) && history.some((entry) => (entry as { kind?: unknown } | null)?.kind === "person")) || (kinds !== null && typeof kinds === "object" && Object.values(kinds as object).includes("person"));
}

async function plainDirs(parent: string, name: RegExp, links: string[], checked = false): Promise<string[]> {
  const out: string[] = [];
  // A root that is itself a link is not entered: it may lead anywhere.
  if (!checked && !(await plainRoot(parent, links))) return out;
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

/** Whether `path` is a real folder; a link is named in `links`, a missing one is just absent. */
async function plainRoot(path: string, links: string[]): Promise<boolean> {
  const stat = await lstat(path).catch(() => null);
  if (!stat) return false;
  if (stat.isSymbolicLink()) {
    links.push(path);
    return false;
  }
  return stat.isDirectory();
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
        let person = false;
        let readable = true;
        try {
          const parsed = JSON.parse(await readFile(path, "utf8")) as { taskId?: unknown; truth?: unknown };
          taskId = parsed.taskId;
          hasTruth = parsed.truth !== undefined && parsed.truth !== null;
          person = personTruth(parsed.truth);
        } catch {
          // A record that cannot be read cannot be told from one with a person's word on it: it is kept by the size cap (fail closed).
          readable = false;
        }
        listed.push({ path, day: dayDir.slice(-10), bytes: stat.size, open: typeof taskId === "string" && openTaskIds.has(taskId), hasTruth, person: person || !readable });
      }
    }
  }
  return listed;
}

/** Whether the record at `path` has a person's truth now (read again, just before a removal). A record that cannot be read counts as having one. */
async function personNow(path: string): Promise<boolean> {
  try {
    return personTruth((JSON.parse(await readFile(path, "utf8")) as { truth?: unknown }).truth);
  } catch {
    return true;
  }
}

/** The bytes of the regular files of a folder tree one level down: ground truth is removed by age only, so the size cap counts it as fixed. */
async function truthBytes(root: string): Promise<number> {
  let total = 0;
  if (!(await plainRoot(root, []))) return 0;
  for (const kind of await plainDirs(root, FOLDER, [], true)) {
    for (const name of await readdir(kind).catch(() => [] as string[])) {
      const stat = await lstat(join(kind, name)).catch(() => null);
      if (stat?.isFile()) total += stat.size;
    }
  }
  return total;
}

export async function pruneLearning(input: PruneInput): Promise<PruneResult> {
  const links: string[] = [];
  const removedPaths = new Set<string>();
  let records = 0;
  let truthFiles = 0;
  let freed = 0;
  let warning: string | null = null;
  const drop = async (item: Listed): Promise<void> => {
    await rm(item.path, { force: true });
    removedPaths.add(item.path);
    records++;
    freed += item.bytes;
  };

  const decisions = join(input.stateDir, DECISIONS_DIR);
  // The root itself is checked: a link in its place is named and not entered.
  const rootIsReal = await plainRoot(decisions, links);
  let listed = rootIsReal ? await listRecords(decisions, input.openTaskIds, links) : [];
  await input.afterListing?.();

  // By age: a day folder older than the retention loses its records, except those of an open card.
  if (input.retentionDays > 0) {
    const cutoff = new Date(input.now.getTime() - input.retentionDays * DAY_MS).toISOString().slice(0, 10);
    for (const item of listed) if (item.day < cutoff && !item.open) await drop(item);
    listed = listed.filter((item) => !removedPaths.has(item.path));
  }

  // By size: the target for what may be pruned is the cap minus the bytes that cannot be (an open card's records, the young, a person's
  // truth, the ground-truth files). Records with no truth go before records with a machine fact or an outcome; a person's never; each is
  // read again just before it goes, since a label may have landed since the listing. When what cannot be pruned is over the cap, every
  // record that may go does, and one warning says the cap cannot be met.
  if (input.maxMb > 0) {
    const cap = input.maxMb * MB;
    const youngest = new Date(input.now.getTime() - MIN_AGE_DAYS * DAY_MS).toISOString().slice(0, 10);
    const prunable = (item: Listed): boolean => !item.open && !item.person && item.day < youngest;
    const fixed = listed.filter((item) => !prunable(item)).reduce((sum, item) => sum + item.bytes, 0) + (await truthBytes(join(input.stateDir, GROUND_TRUTH_DIR)));
    let target = Math.max(0, cap - fixed);
    let room = listed.filter(prunable).reduce((sum, item) => sum + item.bytes, 0);
    const order = listed.filter(prunable).sort((a, b) => Number(a.hasTruth) - Number(b.hasTruth) || a.day.localeCompare(b.day) || a.path.localeCompare(b.path));
    for (const item of order) {
      if (room <= target) break;
      if (await personNow(item.path)) {
        // A person's word landed since the listing: the record now counts among the bytes that cannot be pruned.
        room -= item.bytes;
        target = Math.max(0, target - item.bytes);
        continue;
      }
      await drop(item);
      room -= item.bytes;
    }
    if (fixed > cap) warning = `prune: the size cap of ${input.maxMb} MB cannot be met: ${(fixed / MB).toFixed(1)} MB cannot be pruned (open cards, records under 7 days or with a person's truth, ground truth); raise MACHINE_DECISIONS_MAX_MB or label less`;
    else {
      const after = fixed + listed.filter((item) => prunable(item) && !removedPaths.has(item.path)).reduce((sum, item) => sum + item.bytes, 0);
      if (after > cap) warning = `prune: the size cap of ${input.maxMb} MB cannot be met: ${(after / MB).toFixed(1)} MB are left and none may be pruned (a person's truth landed on records meanwhile)`;
    }
  }

  // Day folders and pack folders the prune emptied go with their last record; a folder with anything else stays.
  const emptied = new Set([...removedPaths].map((path) => path.slice(0, path.lastIndexOf("/"))));
  for (const dir of emptied) {
    await rmdir(dir).catch(() => {});
    await rmdir(dir.slice(0, dir.lastIndexOf("/"))).catch(() => {});
  }

  // Temporary files a dying writer left: older than a day, by the name shapes the two writers use.
  const staleBefore = input.now.getTime() - DAY_MS;
  const sweepTemps = async (folder: string): Promise<void> => {
    for (const name of await readdir(folder).catch(() => [] as string[])) {
      if (!TEMP.test(name)) continue;
      const path = join(folder, name);
      const stat = await lstat(path).catch(() => null);
      if (stat?.isFile() && stat.mtimeMs < staleBefore) await rm(path, { force: true });
    }
  };
  if (rootIsReal) for (const pack of await plainDirs(decisions, FOLDER, links, true)) for (const day of await plainDirs(pack, DAY, links, true)) await sweepTemps(day);

  // Ground truth: a file whose mtime is older than the retention.
  const truthRoot = join(input.stateDir, GROUND_TRUTH_DIR);
  if (await plainRoot(truthRoot, links)) {
    const cutoffMs = input.now.getTime() - input.retentionDays * DAY_MS;
    for (const kind of await plainDirs(truthRoot, FOLDER, links, true)) {
      await sweepTemps(kind);
      if (input.retentionDays <= 0) continue;
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
  return { records, truthFiles, freedBytes: freed, skippedLinks: links, line: `prune: ${parts.join(", ")}`, warning };
}

/** The cards a record may still be needed by: every task that is not closed or archived. */
export async function openTaskIdsOf(db: { query(sql: string): Promise<unknown> }): Promise<Set<string>> {
  const rows = (await db.query("select id from tasks where state not in ('closed', 'archived')")) as Array<{ id: string }>;
  return new Set(rows.map((row) => row.id));
}
