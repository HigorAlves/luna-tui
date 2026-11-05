// The decision log: one file per decision pack call, under the machine's state dir (never a repo):
// `<stateDir>/decisions/<pack>/<yyyy-mm-dd>/<id>.json`, owner-only. Contexts carry repo paths and
// code excerpts, so the files stay on this machine; `pnpm eval harvest` scrubs before anything
// reaches `evals/`. Written atomically (temp file, then rename); swept past the retention.
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { DecisionRecord, type DecisionTruth, type PackId } from "@hardness/contracts";

export const DECISIONS_DIR = "decisions";
/** A record id is a file name: letters, digits, dots, dashes, underscores; never a path. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export interface DecisionAppender {
  append(record: DecisionRecord): Promise<void>;
}

export interface DecisionLogOptions {
  stateDir: string;
  /** `MACHINE_DECISIONS=off` writes nothing. */
  enabled?: boolean;
}

export class DecisionLog implements DecisionAppender {
  private readonly root: string;
  private readonly enabled: boolean;

  constructor(options: DecisionLogOptions) {
    this.root = join(options.stateDir, DECISIONS_DIR);
    this.enabled = options.enabled ?? true;
  }

  async append(record: DecisionRecord): Promise<void> {
    if (!this.enabled) return;
    if (!SAFE_ID.test(record.id)) throw new Error(`decision record id is not a file name: ${record.id}`);
    const dir = join(this.root, record.pack, record.at.slice(0, 10));
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await this.write(join(dir, `${record.id}.json`), record);
  }

  /** A pack's records, oldest first; `since` keeps those at or after it, `withTruth` those with a truth. */
  async list(pack: PackId, options: { since?: Date; withTruth?: boolean } = {}): Promise<DecisionRecord[]> {
    const records: DecisionRecord[] = [];
    for (const day of await this.days(pack)) {
      for (const name of await readdir(join(this.root, pack, day)).catch(() => [])) {
        if (!name.endsWith(".json")) continue;
        const record = await this.load(join(this.root, pack, day, name));
        if (!record) continue;
        if (options.since && new Date(record.at) < options.since) continue;
        if (options.withTruth && !record.truth) continue;
        records.push(record);
      }
    }
    return records.sort((a, b) => a.at.localeCompare(b.at));
  }

  async read(pack: PackId, id: string): Promise<DecisionRecord | null> {
    const path = await this.locate(pack, id);
    return path ? this.load(path) : null;
  }

  /** Rewrites the one file with the truth; false when there is no such record (or the log is off). */
  async setTruth(pack: PackId, id: string, truth: DecisionTruth): Promise<boolean> {
    const path = await this.locate(pack, id);
    const record = path ? await this.load(path) : null;
    if (!path || !record) return false;
    await this.write(path, { ...record, truth });
    return true;
  }

  /** Removes the days older than `retentionDays` (0 keeps everything); the number of records removed. */
  async sweep(retentionDays: number, now: Date = new Date()): Promise<number> {
    if (retentionDays <= 0) return 0;
    const cutoff = new Date(now.getTime() - retentionDays * 86_400_000).toISOString().slice(0, 10);
    let removed = 0;
    for (const pack of await readdir(this.root).catch(() => [])) {
      for (const day of await this.days(pack as PackId)) {
        if (day >= cutoff) continue;
        const dir = join(this.root, pack, day);
        removed += (await readdir(dir).catch(() => [])).filter((name) => name.endsWith(".json")).length;
        await rm(dir, { recursive: true, force: true });
      }
    }
    return removed;
  }

  private async days(pack: PackId): Promise<string[]> {
    return (await readdir(join(this.root, pack)).catch(() => [])).filter((name) => DAY.test(name)).sort();
  }

  private async locate(pack: PackId, id: string): Promise<string | null> {
    if (!SAFE_ID.test(id)) return null;
    for (const day of await this.days(pack)) {
      const path = join(this.root, pack, day, `${id}.json`);
      if (await readFile(path).then(() => true, () => false)) return path;
    }
    return null;
  }

  private async load(path: string): Promise<DecisionRecord | null> {
    try {
      return DecisionRecord.parse(JSON.parse(await readFile(path, "utf8")));
    } catch {
      return null;
    }
  }

  private async write(path: string, record: DecisionRecord): Promise<void> {
    const temp = `${path}.${randomUUID().slice(0, 8)}.tmp`;
    try {
      await writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
      await chmod(temp, 0o600);
      await rename(temp, path);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
  }
}
