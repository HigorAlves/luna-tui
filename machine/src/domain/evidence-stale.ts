// What a new head made stale in an Evidence Pack. Pure. The text (commit, results, findings, summary) is always made again; the film only when what it shows may have changed: its scenarios, a newer run that changed a result or the steps, or a rendered
// surface touched between the two commits. The captures are not a part: the stage always takes the latest run's screenshots, so nothing is redone for them and the report does not claim it. A pack with no `source` (made before this wave) has its text and its film made again.
import type { EvidencePack } from "@hardness/contracts";
import { createHash } from "node:crypto";

export type StalePart = "text" | "film";

export interface StaleNow {
  /** The latest browser run's id. */
  e2eRunId: string | null;
  scenariosKey: string;
  stepsSha: string | null;
  /** The approved scenarios' results in order, as the latest browser run says. */
  results: string[];
  /** Paths changed between the pack's commit and the head; null when they could not be read (the film is then stale: fail safe). */
  changedPaths: string[] | null;
}

const SURFACE_EXT = /\.(?:tsx|jsx|vue|svelte|astro|html|htm|css|scss|sass|less|svg|png|jpe?g|gif|webp|ico|woff2?)$/i;
const SURFACE_DIR = /(?:^|\/)(?:public|static|assets|components|pages|views|templates)\//i;

/** Whether any path is something a person can see on a page. */
export const touchesRenderedSurface = (paths: readonly string[]): boolean => paths.some((p) => SURFACE_EXT.test(p) || SURFACE_DIR.test(p));

/** A hash of the approved scenarios' ids and titles, in order. */
export function scenariosKeyOf(scenarios: readonly { id: string; title: string }[]): string {
  return createHash("sha256").update(JSON.stringify(scenarios.map((s) => [s.id, s.title]))).digest("hex");
}

export function staleParts(previous: EvidencePack | null, now: StaleNow): StalePart[] {
  const source = previous?.source;
  if (!previous || !source) return ["text", "film"];
  const parts: StalePart[] = ["text"];
  const newerRun = now.e2eRunId !== source.e2eRunId;
  const before = previous.scenarios.map((s) => s.result);
  const changedResult = newerRun && (now.results.length !== before.length || now.results.some((r, i) => r !== before[i]) || now.stepsSha !== source.stepsSha);
  if (now.scenariosKey !== source.scenariosKey || changedResult || now.changedPaths === null || touchesRenderedSurface(now.changedPaths)) parts.push("film");
  return parts;
}
