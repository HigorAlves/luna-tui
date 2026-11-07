// Feeds memory from a repository's default branch (RFC 0007, waves M5 and M5b), on the graph's own trigger (a merge, the poll):
//   documents: the markdown under `docs/` and the README, read from the commit's tree (never a working folder), one `ingestDoc` per
//              file whose content changed, `removeDoc` for a file that is gone, then `cognify` of the repository's docs dataset;
//   code:      the commit exported with no `.git` under `<state>/memory/code/<slug>/<commit>/` (the Cognee container sees the folder
//              at `/repos`), `ingestCode` on it, and the previous commit's folder deleted after the new one is in.
// What was last sent is kept in `<state>/memory/sync/<slug>.json` (blob ids per path, the code graph's commit); `memory.list` says what
// memory holds, so a document memory lost is sent again. A failure is a note on the repository (`health`), never thrown, never blocking.
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { datasetFor } from "../domain/memory-datasets.ts";
import { safe } from "../domain/evidence-markdown.ts";
import type { Memory } from "./memory.ts";

/** Where the Cognee container sees `<state>/memory/code` (compose mounts it read-write; wave M1 owns compose). */
export const CODE_CONTAINER_ROOT = "/repos";
/** The files of a repository memory reads: its README at the root and any markdown below `docs/`. */
export const REPO_DOC_PATTERN = /^(?:README[^/]*\.(?:md|markdown)|docs\/(?:.+\/)?[^/]+\.(?:md|markdown))$/i;
export const REPO_DOC_MAX_BYTES = 1024 * 1024;
export const REPO_DOC_MAX_FILES = 500;

/** What the sync reads of git; `adapters/git/main-export.ts` implements it, a test fakes it. */
export interface RepoGit {
  /** The commit `origin/<default>` points at, after a fetch. */
  head(repoPath: string): Promise<string>;
  tree(repoPath: string, commit: string): Promise<Array<{ path: string; sha: string; size: number }>>;
  blob(repoPath: string, sha: string): Promise<Buffer>;
  /** A clean copy of the commit's files, with no `.git`, writable by the Cognee container. */
  exportTo(repoPath: string, commit: string, dest: string): Promise<void>;
}

interface SyncState {
  /** Blob id of each document last sent. */
  docs: Record<string, string>;
  /** The commit whose code graph was last built, and so which folder is on disk. */
  code: string | null;
}

export interface MemorySyncOptions {
  memory: Memory;
  git: RepoGit;
  /** `repoSlug()`: the repository's name in memory. */
  slugOf: (repoPath: string) => string;
  /** `<state dir>/memory`. */
  dir: string;
  log?: (message: string) => void;
}

export interface SyncReport {
  docs: { added: number; changed: number; removed: number; unchanged: number; skipped: number };
  code: "ingested" | "unchanged" | "off";
}

export class MemorySync {
  private readonly reasons = new Map<string, string>();
  private readonly running = new Map<string, Promise<SyncReport | null>>();
  private readonly log: (message: string) => void;

  constructor(private readonly options: MemorySyncOptions) {
    this.log = options.log ?? ((message) => console.warn(message));
  }

  /** The last failure of this repository's sync, flattened and capped; null when the last pass went through. */
  health(repoPath: string): { lastFailure: string | null } {
    return { lastFailure: this.reasons.get(repoPath) ?? null };
  }

  /** One pass for a repository: documents, then code. Never throws; null when memory is off or the pass failed. A pass already running is joined. */
  sync(repoPath: string, head?: string): Promise<SyncReport | null> {
    if (!this.options.memory.enabled) return Promise.resolve(null);
    const running = this.running.get(repoPath);
    if (running) return running;
    const pass = this.pass(repoPath, head)
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.reasons.set(repoPath, safe(message).slice(0, 400));
        this.log(`memory: ${repoPath}: ${message}`);
        return null;
      })
      .finally(() => this.running.delete(repoPath));
    this.running.set(repoPath, pass);
    return pass;
  }

  private async pass(repoPath: string, knownHead?: string): Promise<SyncReport> {
    const { git } = this.options;
    const slug = this.options.slugOf(repoPath);
    const commit = knownHead ?? (await git.head(repoPath));
    const state = this.read(slug);
    const failures: string[] = [];

    const docs = await this.syncDocs(repoPath, slug, commit, state).catch((error: unknown) => {
      failures.push(`documents: ${error instanceof Error ? error.message : String(error)}`);
      return { added: 0, changed: 0, removed: 0, unchanged: 0, skipped: 0 };
    });
    let code: SyncReport["code"] = "unchanged";
    if (state.code !== commit) {
      try {
        await this.syncCode(repoPath, slug, commit, state);
        code = "ingested";
      } catch (error) {
        failures.push(`code graph: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    this.write(slug, state);
    if (failures.length > 0) {
      this.reasons.set(repoPath, safe(failures.join("; ")).slice(0, 400));
      this.log(`memory: ${repoPath}: ${failures.join("; ")}`);
    } else this.reasons.delete(repoPath);
    return { docs, code };
  }

  private async syncDocs(repoPath: string, slug: string, commit: string, state: SyncState): Promise<SyncReport["docs"]> {
    const { memory, git } = this.options;
    const report = { added: 0, changed: 0, removed: 0, unchanged: 0, skipped: 0 };
    const tree = await git.tree(repoPath, commit);
    const candidates = tree.filter((entry) => REPO_DOC_PATTERN.test(entry.path));
    const wanted = candidates.filter((entry) => entry.size <= REPO_DOC_MAX_BYTES).slice(0, REPO_DOC_MAX_FILES);
    report.skipped = candidates.length - wanted.length;
    const held = await memory.list({ repo: slug, kinds: ["doc"], status: ["pending", "active", "stale"] });
    const heldPaths = new Set(held.map((item) => item.source.ref));

    for (const entry of wanted) {
      const sent = state.docs[entry.path];
      if (sent === entry.sha && heldPaths.has(entry.path)) {
        report.unchanged++;
        continue;
      }
      const item = await memory.ingestDoc({ repo: slug, path: entry.path, name: entry.path, content: await git.blob(repoPath, entry.sha), anchors: { files: [entry.path], commit } });
      if (!item) {
        report.skipped++; // memory did not take it: not recorded, so the next pass tries again
        continue;
      }
      state.docs[entry.path] = entry.sha;
      if (sent === undefined && !heldPaths.has(entry.path)) report.added++;
      else report.changed++;
    }

    const present = new Set(tree.map((entry) => entry.path));
    const gone = new Set<string>();
    for (const item of held) if (item.source.ref && !present.has(item.source.ref)) gone.add(item.source.ref);
    for (const path of Object.keys(state.docs)) if (!present.has(path)) gone.add(path);
    for (const path of gone) {
      await memory.removeDoc({ repo: slug, path });
      delete state.docs[path];
      report.removed++;
    }
    if (report.added + report.changed + report.removed > 0) await memory.cognify([datasetFor(slug, { kind: "doc", ref: null })]);
    return report;
  }

  private async syncCode(repoPath: string, slug: string, commit: string, state: SyncState): Promise<void> {
    const { memory, git } = this.options;
    const root = join(this.options.dir, "code", slug);
    const dest = join(root, commit);
    await git.exportTo(repoPath, commit, dest);
    try {
      await memory.ingestCode({ repo: slug, dir: `${CODE_CONTAINER_ROOT}/${slug}/${commit}`, commit });
    } catch (error) {
      rmSync(dest, { recursive: true, force: true });
      throw error;
    }
    state.code = commit;
    for (const name of safeList(root)) if (name !== commit) rmSync(join(root, name), { recursive: true, force: true });
  }

  private file(slug: string): string {
    return join(this.options.dir, "sync", `${slug}.json`);
  }

  private read(slug: string): SyncState {
    try {
      const parsed = JSON.parse(readFileSync(this.file(slug), "utf8")) as Partial<SyncState>;
      return { docs: parsed.docs && typeof parsed.docs === "object" ? parsed.docs : {}, code: typeof parsed.code === "string" ? parsed.code : null };
    } catch {
      return { docs: {}, code: null };
    }
  }

  private write(slug: string, state: SyncState): void {
    writeAtomic(this.file(slug), JSON.stringify(state));
  }
}

const safeList = (dir: string): string[] => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};

/** Writes a file whole or not at all (a temporary name, then a rename). */
export function writeAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, text);
  renameSync(temp, path);
}
