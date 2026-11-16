import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";

/** At machine start: removes every run's `relay` (the real Claude token) and `secrets` folders under `<stateDir>/runs/*`, which a killed machine, or a run that threw before its release, leaves until the runs are pruned. The runs in `keep` (their stage container is still running, and the proxy and the container still mount those files) are left alone. Returns how many folders it removed. */
export async function sweepRunSecrets(stateDir: string, keep: ReadonlySet<string> = new Set()): Promise<number> {
  const runs = join(stateDir, "runs");
  const names = await readdir(runs).catch(() => [] as string[]);
  let removed = 0;
  for (const run of names) {
    if (keep.has(run)) continue;
    for (const folder of ["relay", "secrets"]) {
      const path = join(runs, run, folder);
      if (await readdir(path).then(() => true, () => false)) {
        await rm(path, { recursive: true, force: true });
        removed += 1;
      }
    }
  }
  return removed;
}
