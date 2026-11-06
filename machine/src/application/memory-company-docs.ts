// The company folder (RFC 0007, wave M5): `MACHINE_MEMORY_DOCS` lists absolute host folders (never from a repository's luna.yaml: a repo
// does not get to name what the machine reads from your disk). A poll walks them, sends each changed `.md`, `.txt` or `.pdf` to memory
// with no repository (so it lands in the `company` dataset, which no public post ever sees), retires what was deleted, and cognifies.
// Nothing is followed: a link is skipped and reported, as is a file over the size cap or of another type.
// What was last sent (content hash per document) is kept in `<state>/memory/company-docs.json`.
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, extname, join } from "node:path";

import { COMPANY_DATASET } from "../domain/memory-datasets.ts";
import { safe } from "../domain/evidence-markdown.ts";
import type { Memory } from "./memory.ts";
import { writeAtomic } from "./memory-sync.ts";

export const COMPANY_DOC_TYPES = [".md", ".txt", ".pdf"] as const;
export const COMPANY_DOC_MAX_BYTES = 20 * 1024 * 1024;
const MAX_DEPTH = 12;
const MAX_FILES = 5000;

export interface CompanyDocsReport {
  added: number;
  changed: number;
  removed: number;
  unchanged: number;
  /** Files not read, each with why (a link, too big, a type v1 does not read). */
  skipped: Array<{ path: string; reason: string }>;
  /** A configured folder that could not be read: its documents are left as they were, not retired. */
  unreadable: string[];
}

export interface CompanyDocsOptions {
  memory: Memory;
  /** Absolute host folders. */
  dirs: string[];
  /** `<state dir>/memory`. */
  stateDir: string;
  log?: (message: string) => void;
}

export class CompanyDocs {
  private running: Promise<CompanyDocsReport | null> | null = null;
  private failure: string | null = null;
  private readonly log: (message: string) => void;

  constructor(private readonly options: CompanyDocsOptions) {
    this.log = options.log ?? ((message) => console.warn(message));
  }

  health(): { lastFailure: string | null } {
    return { lastFailure: this.failure };
  }

  /** One pass; never throws. Null when memory is off, no folder is set, or the pass failed. A pass already running is joined. */
  poll(): Promise<CompanyDocsReport | null> {
    if (!this.options.memory.enabled || this.options.dirs.length === 0) return Promise.resolve(null);
    this.running ??= this.pass()
      .catch((error: unknown) => {
        this.failure = safe(error instanceof Error ? error.message : String(error)).slice(0, 400);
        this.log(`memory: company docs: ${this.failure}`);
        return null;
      })
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }

  private statePath = (): string => join(this.options.stateDir, "company-docs.json");

  private readState(): Record<string, string> {
    try {
      const parsed = JSON.parse(readFileSync(this.statePath(), "utf8")) as unknown;
      return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
    } catch {
      return {};
    }
  }

  private async pass(): Promise<CompanyDocsReport> {
    const { memory } = this.options;
    const report: CompanyDocsReport = { added: 0, changed: 0, removed: 0, unchanged: 0, skipped: [], unreadable: [] };
    const state = this.readState();
    const seen = new Set<string>();
    const labels = labelsOf(this.options.dirs);

    for (const [index, dir] of this.options.dirs.entries()) {
      const label = labels[index]!;
      const found: Array<{ rel: string; full: string; size: number }> = [];
      try {
        lstatSync(dir);
        walk(dir, "", 0, found, report, label);
      } catch (error) {
        report.unreadable.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
        for (const key of Object.keys(state)) if (key.startsWith(`${label}/`)) seen.add(key);
        continue;
      }
      for (const file of found) {
        const path = `${label}/${file.rel}`;
        seen.add(path);
        let content: Buffer;
        try {
          content = readFileSync(file.full);
        } catch (error) {
          report.skipped.push({ path, reason: `unreadable: ${error instanceof Error ? error.message : String(error)}` });
          if (path in state) seen.add(path);
          continue;
        }
        const hash = createHash("sha256").update(content).digest("hex");
        if (state[path] === hash) {
          report.unchanged++;
          continue;
        }
        const item = await memory.ingestDoc({ repo: null, path, name: path, content, anchors: { files: [], commit: null } });
        if (!item) {
          report.skipped.push({ path, reason: "memory did not take it; tried again next pass" });
          continue;
        }
        if (path in state) report.changed++;
        else report.added++;
        state[path] = hash;
      }
    }

    for (const path of Object.keys(state)) {
      if (seen.has(path)) continue;
      await memory.removeDoc({ repo: null, path });
      delete state[path];
      report.removed++;
    }
    writeAtomic(this.statePath(), JSON.stringify(state));
    if (report.added + report.changed + report.removed > 0) await memory.cognify([COMPANY_DATASET]);
    this.failure = report.unreadable.length > 0 ? safe(`unreadable folder: ${report.unreadable.join("; ")}`).slice(0, 400) : null;
    return report;
  }
}

/** A prefix for each folder's documents: its name, made unique when two folders share one. */
function labelsOf(dirs: string[]): string[] {
  const used = new Map<string, number>();
  return dirs.map((dir) => {
    const name = basename(dir).replace(/[^A-Za-z0-9._-]+/g, "-") || "docs";
    const n = (used.get(name) ?? 0) + 1;
    used.set(name, n);
    return n === 1 ? name : `${name}-${n}`;
  });
}

function walk(root: string, rel: string, depth: number, out: Array<{ rel: string; full: string; size: number }>, report: CompanyDocsReport, label: string): void {
  const here = rel === "" ? root : join(root, rel);
  for (const entry of readdirSync(here, { withFileTypes: true })) {
    const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
    const full = join(root, childRel);
    const shown = `${label}/${childRel}`;
    const stat = lstatSync(full);
    if (stat.isSymbolicLink()) report.skipped.push({ path: shown, reason: "symbolic link (never followed)" });
    else if (stat.isDirectory()) {
      if (depth >= MAX_DEPTH) report.skipped.push({ path: shown, reason: "too deep" });
      else walk(root, childRel, depth + 1, out, report, label);
    } else if (stat.isFile()) {
      if (!(COMPANY_DOC_TYPES as readonly string[]).includes(extname(entry.name).toLowerCase())) report.skipped.push({ path: shown, reason: "type not read in v1 (md, txt, pdf only)" });
      else if (stat.size > COMPANY_DOC_MAX_BYTES) report.skipped.push({ path: shown, reason: "over the 20 MB cap" });
      else if (out.length >= MAX_FILES) report.skipped.push({ path: shown, reason: "folder holds too many files" });
      else out.push({ rel: childRel, full, size: stat.size });
    }
  }
}
