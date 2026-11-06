// What a baseline run needs, checked without a model call or a container, and the table of a pack's cases for a person to read.
import { type EngineId, PACKS, type PackId, decisionEngines } from "@hardness/contracts";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { loadCases } from "./cases.ts";
import { type CaseView, checkReading } from "./reading.ts";

export const MIN_CASES = 8;
export const MIN_LABELLED_CASES = 6;

export const decisionPackIds = (): PackId[] => Object.values(PACKS).filter((p) => p.kind === "decision").map((p) => p.id);

/** Every engine a decision pack names (default, fallback) once, in a fixed order. */
export const decisionEngineIds = (): EngineId[] => [...new Set(decisionPackIds().flatMap((p) => [decisionEngines(p).default, ...decisionEngines(p).fallback]))].sort();

/** A hand-written case: harvested ones (`rec-`) carry a recorded truth and no reading. */
export const handWritten = (id: string): boolean => !id.startsWith("rec-");

const stageOf = (evalsDir: string, pack: PackId, id: string): unknown => JSON.parse(readFileSync(join(evalsDir, pack, "cases", id, "stage.json"), "utf8"));

/** The views of a pack's cases (id, expect, stage) for the reading check. */
export function caseViews(evalsDir: string, pack: PackId): CaseView[] {
  if (!existsSync(join(evalsDir, pack, "cases"))) return [];
  return loadCases(evalsDir, pack).map((c) => ({ id: c.id, expect: c.expect, stage: stageOf(evalsDir, pack, c.id) }));
}

/** Every problem of every hand-written case of a pack, each naming `pack/case`. */
export function readingProblems(evalsDir: string, pack: PackId): string[] {
  const views = caseViews(evalsDir, pack);
  return views.filter((v) => handWritten(v.id)).flatMap((v) => checkReading(pack, v.id, v.expect, v.stage, views).map((p) => `${pack}/${v.id}: ${p}`));
}

const quote = (text: string): string => (text.length > 80 ? `${text.slice(0, 77)}...` : text);
const labelText = (label: Record<string, Record<string, unknown>> | null | undefined): string =>
  label ? Object.entries(label).map(([q, e]) => Object.entries(e).map(([k, v]) => `${q}.${k}=${JSON.stringify(v)}`.replace(/"/g, "")).join(" ")).join(" ") : "-";

/** One row per case: id, kind, the label, the criterion quoted, the twin, the second reading. */
export function casesTable(evalsDir: string, pack: PackId): string[] {
  return caseViews(evalsDir, pack).map((v) => {
    const { expect: e } = v;
    const criterion = Object.values(e.reading?.criteria ?? {})[0] ?? Object.values(e.reading?.readings?.[0]?.criteria ?? {})[0] ?? "";
    const second = e.reading ? `second: ${labelText(e.reading.second.label)}${e.reading.second.agrees ? " agrees" : " DISAGREES"}` : "no reading";
    return [`${v.id}`, e.kind ?? "-", labelText(e.label), criterion ? `"${quote(criterion)}"` : "", e.twin ? `twin ${e.twin}` : "", second].filter((cell) => cell !== "").join("  |  ");
  });
}

export interface PreflightDeps {
  imageExists(image: string): Promise<boolean>;
  check(engine: EngineId): Promise<{ available: true } | { available: false; reason: string }>;
  collector(): Promise<boolean>;
}

/** One line per check; `ok` is false when any line starts with `fail`. A collector that is down is a warning. Nothing is built, started or sent. */
export async function preflight(evalsDir: string, deps: PreflightDeps, options: { packs?: PackId[]; engines?: EngineId[]; image?: string } = {}): Promise<{ ok: boolean; lines: string[] }> {
  const lines: string[] = [];
  for (const pack of options.packs ?? decisionPackIds()) {
    const views = caseViews(evalsDir, pack);
    const labelled = views.filter((v) => v.expect.label).length;
    const adversarial = views.filter((v) => v.expect.kind === "adversarial" && v.expect.twin && views.some((o) => o.id === v.expect.twin)).length;
    const borderline = views.filter((v) => v.expect.kind === "borderline").length;
    const short = [
      ...(views.length < MIN_CASES ? [`${views.length} case${views.length === 1 ? "" : "s"}, ${MIN_CASES} needed`] : []),
      ...(labelled < MIN_LABELLED_CASES ? [`${labelled} labelled, ${MIN_LABELLED_CASES} needed`] : []),
      ...(adversarial < 1 ? ["no adversarial case with its twin"] : []),
      ...(borderline < 1 ? ["no borderline case"] : []),
    ];
    lines.push(short.length === 0 ? `ok    ${pack}: ${views.length} cases, ${labelled} labelled, ${adversarial} adversarial, ${borderline} borderline` : `fail  ${pack}: ${short.join("; ")}`);
    for (const problem of readingProblems(evalsDir, pack)) lines.push(`fail  ${problem}`);
  }
  const image = options.image ?? "hardness-runner:dev";
  lines.push((await deps.imageExists(image)) ? `ok    the runner image ${image} exists` : `fail  the runner image ${image} is not there (pnpm --filter @hardness/machine runner:build builds it; this check never does)`);
  for (const engine of options.engines ?? decisionEngineIds()) {
    const found = await deps.check(engine);
    lines.push(found.available ? `ok    ${engine}: a credential is present` : `fail  ${engine}: ${found.reason}`);
  }
  lines.push((await deps.collector()) ? "ok    the trace collector answers" : "warn  the trace collector does not answer: a run leaves no traces (docker compose --profile observe up -d starts it)");
  return { ok: !lines.some((l) => l.startsWith("fail")), lines };
}

