// Where a GitHub repo lives on this machine. GitHub intake creates tasks for `owner/name`;
// a real stage needs the checkout's path. `MACHINE_REPO_MAP` says so outright; otherwise
// the checkouts one level under `MACHINE_REPOS_DIR` are matched by their `origin` remote.
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { exec } from "../adapters/process/exec.ts";

export interface RepoMapOptions {
  /** `owner/name` to an absolute path, from configuration. */
  map: Record<string, string>;
  /** The directory whose immediate children are checkouts to scan. */
  reposDir: string;
  /** Runs git; tests may pass a fake. */
  exec?: typeof exec;
  /** A JSON file that keeps the links `remember` is told about across restarts. */
  file?: string;
}

/** How deep under the repos dir the scan looks: `Developer/projects/orc` is two. */
const SCAN_DEPTH = 2;
const SKIP = new Set(["node_modules", "target", "dist", "build", "vendor"]);

/** `owner/name` from a GitHub remote URL (ssh or https, with or without .git); null for anything else. */
export function originSlug(url: string): string | null {
  const match = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?\s*$/.exec(url.trim());
  return match ? `${match[1]}/${match[2]}` : null;
}

export class RepoMap {
  private readonly found = new Map<string, string>();
  private readonly exec: typeof exec;
  private loaded: Promise<void> | null = null;
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly options: RepoMapOptions) {
    this.exec = options.exec ?? exec;
  }

  /** The checkout for `owner/name`, or null when neither the map nor the scan knows it. */
  async resolve(repo: string): Promise<string | null> {
    const key = repo.toLowerCase();
    await this.load();
    const mapped = Object.entries(this.options.map).find(([slug]) => slug.toLowerCase() === key)?.[1];
    if (mapped) return mapped;
    const remembered = this.found.get(key);
    if (remembered) return remembered;
    for (const [slug, path] of await this.scan()) this.found.set(slug, path);
    return this.found.get(key) ?? null;
  }

  /** A checkout that just appeared (a clone the board asked for): resolve `repo` to it from now on. */
  remember(repo: string, path: string): void {
    this.found.set(repo.toLowerCase(), path);
    const { file } = this.options;
    if (!file) return;
    const links = Object.fromEntries(this.found);
    this.writing = this.writing
      .then(async () => {
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, JSON.stringify(links, null, 2));
      })
      .catch((error) => console.warn(`repo links: could not save ${file}: ${error instanceof Error ? error.message : error}`));
  }

  /** Resolves once the links written so far are on disk. */
  saved(): Promise<void> {
    return this.writing;
  }

  /** Reads the saved links once; a missing or damaged file, or a folder that is gone, is skipped. */
  private load(): Promise<void> {
    this.loaded ??= (async () => {
      const { file } = this.options;
      if (!file) return;
      let saved: unknown;
      try {
        saved = JSON.parse(await readFile(file, "utf8"));
      } catch {
        return;
      }
      if (typeof saved !== "object" || saved === null) return;
      for (const [slug, path] of Object.entries(saved)) {
        if (typeof path !== "string" || !(await stat(path).catch(() => null))) continue;
        if (!this.found.has(slug.toLowerCase())) this.found.set(slug.toLowerCase(), path);
      }
    })();
    return this.loaded;
  }

  /** Every checkout under the repos dir (up to `SCAN_DEPTH` folders down) with a GitHub origin, as (slug, path). */
  private async scan(): Promise<Array<[string, string]>> {
    const pairs: Array<[string, string]> = [];
    const walk = async (dir: string, depth: number): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith(".") || SKIP.has(entry.name)) continue;
        const path = join(dir, entry.name);
        const origin = await this.exec("git", ["-C", path, "remote", "get-url", "origin"]);
        if (origin.code === 0) {
          const slug = originSlug(origin.stdout);
          if (slug) pairs.push([slug.toLowerCase(), path]);
        } else if (depth + 1 < SCAN_DEPTH && !(await stat(join(path, ".git")).catch(() => null))) {
          // A plain folder of checkouts (`projects/`): look inside. A checkout is never searched.
          await walk(path, depth + 1);
        }
      }
    };
    await walk(this.options.reposDir, 0);
    return pairs;
  }
}
