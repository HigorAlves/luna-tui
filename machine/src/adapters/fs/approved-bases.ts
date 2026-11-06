// The base images a person approved, in the machine's own state: `<dir>/approved-bases.json`, a repository's path and the exact
// references approved for it. A base runs the factory process in a stage container and so can read the stage's credential: it is
// trusted like code the user runs, and only after a person said so for that exact reference and that repository.
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { readRegularFile } from "./bounded.ts";

const FILE = "approved-bases.json";
const MAX_BYTES = 1024 * 1024;

export interface ApprovedBases {
  isApproved(repoPath: string, base: string): Promise<boolean>;
  approve(repoPath: string, base: string): Promise<void>;
}

export function approvedBases(dir: string): ApprovedBases {
  const path = join(dir, FILE);
  const read = async (): Promise<Record<string, string[]>> => {
    try {
      const parsed = JSON.parse(await readRegularFile(path, MAX_BYTES)) as unknown;
      return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, string[]>) : {};
    } catch {
      return {};
    }
  };
  let writing: Promise<unknown> = Promise.resolve();
  return {
    async isApproved(repoPath, base) {
      const refs = (await read())[repoPath];
      return Array.isArray(refs) && refs.includes(base);
    },
    approve(repoPath, base) {
      const job = writing.then(async () => {
        const all = await read();
        const refs = Array.isArray(all[repoPath]) ? all[repoPath]! : [];
        if (refs.includes(base)) return;
        all[repoPath] = [...refs, base];
        await mkdir(dir, { recursive: true });
        const tmp = `${path}.${process.pid}.tmp`;
        await writeFile(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
        await rename(tmp, path);
      });
      writing = job.catch(() => undefined);
      return job;
    },
  };
}
