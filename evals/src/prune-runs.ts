// `pnpm eval prune-runs`: removes run folders under `evals/.runs/` older than a number of days, by the stamp in the folder's name. Links, files and
// anything not named as a stamp are left alone and named; nothing outside the folder it is given is touched.
import { lstatSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const STAMP = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/;

export function pruneRuns(dir: string, options: { olderThanDays: number; now?: Date }): { removed: string[]; skipped: string[] } {
  const out = { removed: [] as string[], skipped: [] as string[] };
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  const cutoff = (options.now ?? new Date()).getTime() - options.olderThanDays * 86_400_000;
  for (const name of names) {
    const match = STAMP.exec(name);
    const stat = lstatSync(join(dir, name), { throwIfNoEntry: false });
    const at = match ? Date.parse(`${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`) : Number.NaN;
    if (!match || Number.isNaN(at) || !stat || stat.isSymbolicLink() || !stat.isDirectory()) {
      out.skipped.push(name);
      continue;
    }
    if (at < cutoff) {
      rmSync(join(dir, name), { recursive: true, force: true });
      out.removed.push(name);
    }
  }
  return out;
}
