// Reads each repo's PIPELINE.md on demand, so an edit takes effect at the next stage with
// no restart. A file that stops parsing keeps the last policy that did (or the defaults),
// and says so once per bad version rather than on every read.
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { DEFAULT_POLICY, type Policy, parsePolicy } from "../domain/policy.ts";

export const POLICY_FILE = "PIPELINE.md";

interface Cached {
  /** The file's mtime and size when `policy` was read; a change re-reads it. */
  stamp: string | null;
  policy: Policy;
  /** The stamp of the version that failed to parse, so the warning fires once per version. */
  badStamp: string | null;
}

export interface PolicyStoreOptions {
  warn?: (message: string) => void;
}

export class PolicyStore {
  private readonly cache = new Map<string, Cached>();
  private readonly warn: (message: string) => void;

  constructor(options: PolicyStoreOptions = {}) {
    this.warn = options.warn ?? ((message) => console.warn(message));
  }

  /** The repo's policy right now; the defaults for a repo without one, or for no repo. */
  async for(repoPath: string | null): Promise<Policy> {
    if (!repoPath) return { ...DEFAULT_POLICY };
    const file = join(repoPath, POLICY_FILE);
    const cached = this.cache.get(repoPath) ?? { stamp: null, policy: { ...DEFAULT_POLICY }, badStamp: null };
    let stamp: string | null;
    try {
      const info = await stat(file);
      stamp = `${info.mtimeMs}:${info.size}`;
    } catch {
      stamp = null; // no file: the defaults
    }
    if (stamp === null) {
      this.cache.set(repoPath, { stamp: null, policy: { ...DEFAULT_POLICY }, badStamp: null });
      return { ...DEFAULT_POLICY };
    }
    if (stamp === cached.stamp || stamp === cached.badStamp) return { ...cached.policy };
    try {
      const policy = parsePolicy(await readFile(file, "utf8"));
      this.cache.set(repoPath, { stamp, policy, badStamp: null });
      return { ...policy };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.warn(`${file}: ${message}; keeping the last good policy`);
      this.cache.set(repoPath, { ...cached, badStamp: stamp });
      return { ...cached.policy };
    }
  }
}
