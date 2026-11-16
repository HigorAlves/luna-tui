// The docs-drift note beside Verify: when the repo has docs and the change touches more than docs, the
// docs-keeper reads the change and names the doc sections it made stale. It is advice and never a gate:
// each section becomes a nit on the report, and a pack that fails or answers badly leaves a note and nothing else.
import { DOCS_DRIFT_CHANGED_FILES, DOCS_DRIFT_DOC_FILES, DocsDriftAnswer, type DocsDriftContext, type Finding } from "@hardness/contracts";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import type { StageContext, StageResult } from "../ports.ts";

export interface DocsDriftDeps {
  /** Runs the docs_drift pack, as a sub-run beside the stage's own pack. */
  run: (context: StageContext, drift: DocsDriftContext) => Promise<StageResult>;
  /** The repo's doc files, worktree-relative; the markdown under `docs/` and the root README by default. */
  docFiles?: (cwd: string) => Promise<string[]>;
}

export interface DocsDriftOutcome {
  /** One nit per stale section, in review-contract shape. */
  findings: Finding[];
  notes: string[];
  /** What the sub-run cost, for the stage to add to its own. */
  usage?: StageResult["usage"];
}

const DOC = /\.(md|mdx|markdown|rst|adoc|txt)$|(^|\/)(docs?|documentation)\//i;
const SKIP = new Set(["node_modules", ".git"]);

/** The markdown under `docs/` and the README files at the root, sorted, at most `DOCS_DRIFT_DOC_FILES`. */
export async function listDocFiles(cwd: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (rel: string): Promise<void> => {
    const entries = await readdir(join(cwd, rel), { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (found.length >= DOCS_DRIFT_DOC_FILES) return;
      if (SKIP.has(entry.name)) continue;
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && /\.md$/i.test(entry.name)) found.push(path);
    }
  };
  const root = await readdir(cwd, { withFileTypes: true }).catch(() => []);
  for (const entry of root) if (entry.isFile() && /^readme.*\.md$/i.test(entry.name)) found.push(entry.name);
  await walk("docs");
  return found.sort().slice(0, DOCS_DRIFT_DOC_FILES);
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Runs the docs-drift review of the change in `cwd` for the repo `slug`; null when there is nothing to check: no docs, an unknown diff, or a diff that touches only docs. */
export async function runDocsDrift(deps: DocsDriftDeps, context: StageContext, slug: string, cwd: string, changedFiles: readonly string[] | null): Promise<DocsDriftOutcome | null> {
  if (!changedFiles || !changedFiles.some((file) => !DOC.test(file))) return null;
  const docFiles = await (deps.docFiles ?? listDocFiles)(cwd).catch(() => []);
  if (docFiles.length === 0) return null;
  let usage: StageResult["usage"];
  const skipped = (why: string): DocsDriftOutcome => ({ findings: [], notes: [`docs drift did not run: ${why}`], ...(usage ? { usage } : {}) });
  let pack: StageResult;
  try {
    pack = await deps.run({ ...context, runId: `${context.runId}-docs`, started: undefined, resume: undefined, engine: undefined }, { repo: slug, changedFiles: changedFiles.slice(0, DOCS_DRIFT_CHANGED_FILES), docFiles: docFiles.slice(0, DOCS_DRIFT_DOC_FILES) });
  } catch (error) {
    return skipped(messageOf(error));
  }
  usage = pack.usage;
  if (pack.outcome !== "pass") return skipped(`the pack ${pack.outcome === "fail" ? "failed" : pack.outcome}`);
  const parsed = DocsDriftAnswer.safeParse(pack.detail?.answer);
  if (!parsed.success) return skipped("its answer did not parse");
  return {
    findings: parsed.data.stale.map(({ doc, section, why, suggestion }) => ({
      path: doc,
      line: 1,
      severity: "nit",
      title: `Docs drift: ${doc}${section ? ` ${section}` : ""}`,
      body: `${why} ${suggestion}`,
      confidence: 0.6,
      category: "convention" as const,
    })),
    notes: [],
    ...(usage ? { usage } : {}),
  };
}
