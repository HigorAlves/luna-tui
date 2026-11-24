// Reads each repo's luna.yaml on demand, so an edit takes effect at the next stage with no
// restart; a repo with only the older PIPELINE.md still works, with one deprecation notice.
// A file that stops parsing keeps the last policy that did (or the defaults), and says so
// once per bad version rather than on every read.
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { CONFIG_FILE, parseLunaConfig } from "../domain/luna-config.ts";
import type { MachinePolicy } from "@hardness/contracts";

import { boundSandbox } from "../domain/sandbox-bounds.ts";
import { DEFAULT_POLICY, type Policy, parsePolicy } from "../domain/policy.ts";

export { CONFIG_FILE };
/** The deprecated per-repo file; read only when there is no luna.yaml. */
export const POLICY_FILE = "PIPELINE.md";

interface Cached {
  /** The file's name, mtime and size when `policy` was read; a change re-reads it. */
  stamp: string | null;
  policy: Policy;
  /** The stamp of the version that failed to parse, so the warning fires once per version. */
  badStamp: string | null;
  /** Whether this repo was told its PIPELINE.md is deprecated. */
  deprecationSaid: boolean;
}

export interface PolicyStoreOptions {
  warn?: (message: string) => void;
  /** The owner's sandbox policy: every policy this store hands out has its `factory.sandbox` held within it. Absent, a repo's values stand. */
  machinePolicy?: MachinePolicy;
}

const fresh = (): Policy => ({ ...DEFAULT_POLICY, qaTargets: [], services: {}, toolchains: {}, sla: {}, engines: {}, engineBudgets: {}, decisions: {}, freeze: [] });

export class PolicyStore {
  private readonly cache = new Map<string, Cached>();
  private readonly warn: (message: string) => void;

  private readonly machinePolicy: MachinePolicy | null;

  constructor(options: PolicyStoreOptions = {}) {
    this.warn = options.warn ?? ((message) => console.warn(message));
    this.machinePolicy = options.machinePolicy ?? null;
  }

  /** The repo's policy right now, its sandbox held within the machine's policy; the defaults for a repo without one, or for no repo. */
  async for(repoPath: string | null): Promise<Policy> {
    const policy = await this.read(repoPath);
    if (!this.machinePolicy) return policy;
    const { sandbox, bounds } = boundSandbox(policy.factory.sandbox, this.machinePolicy);
    return { ...policy, factory: { ...policy.factory, sandbox }, bounds };
  }

  private async read(repoPath: string | null): Promise<Policy> {
    if (!repoPath) return fresh();
    const cached = this.cache.get(repoPath) ?? { stamp: null, policy: fresh(), badStamp: null, deprecationSaid: false };
    const found = await this.locate(repoPath);
    if (!found) {
      this.cache.set(repoPath, { ...cached, stamp: null, policy: fresh(), badStamp: null });
      return fresh();
    }
    if (found.name === POLICY_FILE && !cached.deprecationSaid) {
      this.warn(`${found.file}: PIPELINE.md is deprecated; move its keys to ${CONFIG_FILE} (the board's :setup writes one)`);
      cached.deprecationSaid = true;
    }
    if (found.stamp === cached.stamp || found.stamp === cached.badStamp) return { ...cached.policy };
    try {
      const text = await readFile(found.file, "utf8");
      // A dropped key (an unknown task state under `jira.on`, say) is said once per version too.
      const policy = found.name === CONFIG_FILE ? parseLunaConfig(text, (message) => this.warn(`${found.file}: ${message}`)) : parsePolicy(text);
      this.cache.set(repoPath, { ...cached, stamp: found.stamp, policy, badStamp: null });
      return { ...policy };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.warn(`${found.file}: ${message}; keeping the last good policy`);
      this.cache.set(repoPath, { ...cached, badStamp: found.stamp });
      return { ...cached.policy };
    }
  }

  /** luna.yaml if present, else PIPELINE.md, else null; the stamp names the file so a switch re-reads. */
  private async locate(repoPath: string): Promise<{ name: string; file: string; stamp: string } | null> {
    for (const name of [CONFIG_FILE, POLICY_FILE]) {
      const file = join(repoPath, name);
      try {
        const info = await stat(file);
        return { name, file, stamp: `${name}:${info.mtimeMs}:${info.size}` };
      } catch {
        // not this one
      }
    }
    return null;
  }
}
