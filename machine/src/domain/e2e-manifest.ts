// The browser run's manifest as the machine checks it: one row per approved scenario by id, whatever the container wrote.
// Pure but for the artifact check, which looks at files a container wrote: a name only, a regular file, never a link, never opened.
import { lstat } from "node:fs/promises";
import { join } from "node:path";

import { safe } from "./evidence-markdown.ts";
import { ARTIFACT_NAME } from "./send-back.ts";

export type ScenarioResult = "pass" | "fail" | "partial" | "not_run";

export interface ManifestRow {
  scenario: string;
  title: string;
  criterion: string | null;
  result: ScenarioResult;
  /** What the run saw, flattened and capped. */
  seen: string;
  /** Artifact names (a screenshot, a clip, the console and network logs), not yet checked against the folder. */
  artifacts: string[];
}

const SEEN_CAP = 400;
const ARTIFACTS_MAX = 8;
const ARTIFACT_BYTES_MAX = 500_000_000;

interface RawRow {
  text?: unknown;
  criterion?: unknown;
  result?: unknown;
  note?: unknown;
  evidence?: unknown;
}

const objectRow = (r: unknown): RawRow | null => (r !== null && typeof r === "object" && !Array.isArray(r) ? (r as RawRow) : null);

/** The rows of the approved scenarios, in their order: a run's row is its scenario's when it copies the title or names the scenario id as its criterion; a scenario with no row is `not_run`. */
export function manifestRows(scenarios: ReadonlyArray<{ id: string; title: string; criterion_ref?: string | null }>, raw: readonly unknown[], fallbackSeen: string): ManifestRow[] {
  const rows = raw.map(objectRow).filter((r): r is RawRow => r !== null);
  return scenarios.map((s) => {
    const row = rows.find((r) => r.text === s.title) ?? rows.find((r) => typeof r.criterion === "string" && r.criterion === s.id);
    if (!row) return { scenario: s.id, title: s.title, criterion: s.criterion_ref ?? null, result: "not_run", seen: "", artifacts: [] };
    const result: ScenarioResult = row.result === "pass" || row.result === "fail" ? row.result : "partial";
    const note = typeof row.note === "string" && row.note ? row.note : result === "pass" ? "" : fallbackSeen;
    const names = Array.isArray(row.evidence) ? row.evidence.filter((e): e is string => typeof e === "string") : [];
    return { scenario: s.id, title: s.title, criterion: s.criterion_ref ?? null, result, seen: safe(note).slice(0, SEEN_CAP), artifacts: names.map((n) => (n.startsWith("files/qa/") ? n.slice("files/qa/".length) : n)).slice(0, ARTIFACTS_MAX) };
  });
}

/** The names that are plain file names of regular files in `dir` (not a link, not a directory, within the size cap); the rest are dropped. */
export async function boundedArtifacts(names: readonly string[], dir: string | null): Promise<string[]> {
  if (!dir) return [];
  const kept: string[] = [];
  for (const name of names) {
    if (!ARTIFACT_NAME.test(name)) continue;
    const info = await lstat(join(dir, name)).catch(() => null);
    if (info?.isFile() && info.size <= ARTIFACT_BYTES_MAX) kept.push(name);
  }
  return kept;
}
