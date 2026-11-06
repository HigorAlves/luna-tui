// The local copy of an Evidence Pack and its media: `<stateDir>/evidence/<task>/<sha>/`. It is
// the media store when the machine has no GitHub token, and what Ship publishes from when it has
// one. The task id and sha come from the machine; file names come from a container, so they are
// reduced to `[A-Za-z0-9._-]` and nothing but a regular file under the size cap is copied.
import { lstat, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { copyRegularFile } from "../adapters/fs/bounded.ts";

const MEGABYTE = 1024 * 1024;
export const MAX_MEDIA_BYTES = 512 * MEGABYTE;
const DAY_MS = 86_400_000;
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** A file name a container chose, made safe: separators and anything odd become `_`, no leading dot. */
export function safeName(label: string): string {
  const flat = label.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^[._]+/, "").slice(0, 120);
  return flat === "" ? "file" : flat;
}

export interface EvidenceStoreOptions {
  maxFileBytes?: number;
}

export class EvidenceStore {
  private readonly maxFileBytes: number;

  constructor(
    private readonly stateDir: string,
    options: EvidenceStoreOptions = {},
  ) {
    this.maxFileBytes = options.maxFileBytes ?? MAX_MEDIA_BYTES;
  }

  /** Where a task's evidence at one commit lives; throws on an id that is not one path segment. */
  dirFor(taskId: string, sha: string): string {
    for (const part of [taskId, sha]) if (!SAFE_SEGMENT.test(part)) throw new Error(`not a safe evidence path segment: ${part}`);
    return join(this.stateDir, "evidence", taskId, sha);
  }

  /** Copies each regular file (no symlink, no directory, under the cap) into the task's dir and says where each went. */
  async keep(taskId: string, sha: string, files: { path: string; label: string }[]): Promise<{ label: string; path: string }[]> {
    const dir = this.dirFor(taskId, sha);
    await mkdir(dir, { recursive: true });
    const taken = new Set<string>(["pack.json"]);
    const kept: { label: string; path: string }[] = [];
    for (const file of files) {
      const info = await lstat(file.path).catch(() => null);
      if (!info?.isFile() || info.size > this.maxFileBytes) continue;
      let name = safeName(file.label);
      for (let n = 2; taken.has(name); n++) name = `${n}-${safeName(file.label)}`;
      taken.add(name);
      const dest = join(dir, name);
      // Through the open file, never following a link: a file swapped in after the check is refused here.
      if (!(await copyRegularFile(file.path, dest).then(() => true, () => false))) continue;
      kept.push({ label: file.label, path: dest });
    }
    return kept;
  }

  /** `pack.json` beside the media: what the sweep dates a store entry by. */
  async writePack(taskId: string, sha: string, pack: unknown): Promise<void> {
    const dir = this.dirFor(taskId, sha);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "pack.json"), JSON.stringify(pack, null, 2));
  }
}

/** Removes `<task>/<sha>` dirs whose `pack.json` (else the dir) is older than the retention. 0 keeps everything.
 *  `retention` may be a function of the task id, so a repo's own `evidence.retention_days` wins over the machine's. Returns how many were removed. */
export async function sweepEvidenceStore(stateDir: string, retention: number | ((taskId: string) => Promise<number>), now: Date): Promise<number> {
  const root = join(stateDir, "evidence");
  const tasks = await readdir(root).catch(() => [] as string[]);
  let removed = 0;
  for (const task of tasks) {
    const days = typeof retention === "number" ? retention : await retention(task).catch(() => 0);
    if (days <= 0) continue;
    const taskDir = join(root, task);
    for (const sha of await readdir(taskDir).catch(() => [] as string[])) {
      const dir = join(taskDir, sha);
      const info = (await stat(join(dir, "pack.json")).catch(() => null)) ?? (await stat(dir).catch(() => null));
      if (!info || now.getTime() - info.mtimeMs <= days * DAY_MS) continue;
      await rm(dir, { recursive: true, force: true });
      removed++;
    }
    if ((await readdir(taskDir).catch(() => ["x"])).length === 0) await rm(taskDir, { recursive: true, force: true });
  }
  return removed;
}
