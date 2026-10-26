// Where a GitHub repo lives on this machine. GitHub intake creates tasks for `owner/name`;
// a real stage needs the checkout's path. `MACHINE_REPO_MAP` says so outright; otherwise
// the checkouts one level under `MACHINE_REPOS_DIR` are matched by their `origin` remote.
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { exec } from "../adapters/process/exec.ts";

export interface RepoMapOptions {
  /** `owner/name` to an absolute path, from configuration. */
  map: Record<string, string>;
  /** The directory whose immediate children are checkouts to scan. */
  reposDir: string;
  /** Runs git; tests may pass a fake. */
  exec?: typeof exec;
}

/** `owner/name` from a GitHub remote URL (ssh or https, with or without .git); null for anything else. */
export function originSlug(url: string): string | null {
  const match = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?\s*$/.exec(url.trim());
  return match ? `${match[1]}/${match[2]}` : null;
}

export class RepoMap {
  private readonly found = new Map<string, string>();
  private readonly exec: typeof exec;

  constructor(private readonly options: RepoMapOptions) {
    this.exec = options.exec ?? exec;
  }

  /** The checkout for `owner/name`, or null when neither the map nor the scan knows it. */
  async resolve(repo: string): Promise<string | null> {
    const key = repo.toLowerCase();
    const mapped = Object.entries(this.options.map).find(([slug]) => slug.toLowerCase() === key)?.[1];
    if (mapped) return mapped;
    const remembered = this.found.get(key);
    if (remembered) return remembered;
    for (const [slug, path] of await this.scan()) this.found.set(slug, path);
    return this.found.get(key) ?? null;
  }

  /** Every checkout under the repos dir with a GitHub origin, as (slug, path). */
  private async scan(): Promise<Array<[string, string]>> {
    let entries;
    try {
      entries = await readdir(this.options.reposDir, { withFileTypes: true });
    } catch {
      return [];
    }
    const pairs: Array<[string, string]> = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const path = join(this.options.reposDir, entry.name);
      const origin = await this.exec("git", ["-C", path, "remote", "get-url", "origin"]);
      if (origin.code !== 0) continue;
      const slug = originSlug(origin.stdout);
      if (slug) pairs.push([slug.toLowerCase(), path]);
    }
    return pairs;
  }
}
