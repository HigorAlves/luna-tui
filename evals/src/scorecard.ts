// The scorecard over every baseline, and the default each decision slot should run on (RFC 0005
// wave 7). The rule, stated once and applied by `proposeDefaults`:
//   - an engine qualifies with coverage >= 0.6 and at least 4 graded cases;
//   - the best is the highest acted-on accuracy among those; engines within 2 points of it tie,
//     and a tie goes to Jev when it is among them (by far the cheapest engine; the user's choice of 2026-11-05),
//     else to the cheaper engine (cost per case);
//   - an engine that acted on every case and was right on every one wins outright over engines that only tie on
//     what they acted on (the user's choice of 2026-11-06); among several such, Jev, else the cheaper;
//   - a pack with fewer than two engines measured keeps its current default and reads `unmeasured`.
// Pure over scorecards; `cli.ts` reads and writes the files.
import { DecisionDefaults, type DecisionDefault, type EngineId, PACKS, type PackId } from "@hardness/contracts";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import type { Scorecard } from "./grade.ts";

export const MIN_COVERAGE = 0.6;
export const MIN_CASES = 4;
export const TIE_POINTS = 0.02;
const ALLOWED: EngineId[] = ["jev", "claude:haiku", "codex:luna"];

export const RULE = `An engine qualifies with coverage >= ${MIN_COVERAGE} and n >= ${MIN_CASES}. The default is the qualifying engine with the highest acted-on accuracy; engines within ${TIE_POINTS * 100} points of it tie, and a tie goes to Jev when it is among them (by far the cheapest engine), else to the cheaper one (cost per case). A pack with fewer than two engines measured keeps its current default. An engine that acted on every case and was right on every one wins outright; among several such, Jev, else the cheaper.`;

/** Every decision pack's baselines under `evals/baselines/<engine>/<pack>.json`, those that parse. */
export function loadBaselines(evalsDir: string): Scorecard[] {
  const root = join(evalsDir, "baselines");
  if (!existsSync(root)) return [];
  const cards: Scorecard[] = [];
  for (const engineDir of readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory())) {
    for (const file of readdirSync(join(root, engineDir.name)).filter((f) => f.endsWith(".json"))) {
      try {
        const card = JSON.parse(readFileSync(join(root, engineDir.name, file), "utf8")) as Scorecard;
        if (card.schema === 1 && PACKS[card.pack]?.kind === "decision" && card.summary?.calibration) cards.push(card);
      } catch {
        // A file that is not a scorecard is not a baseline.
      }
    }
  }
  return cards.sort((a, b) => a.pack.localeCompare(b.pack) || a.engine.localeCompare(b.engine));
}

const costPerCase = (card: Scorecard): number => (card.summary.costUsd === null || card.summary.cases === 0 ? Number.POSITIVE_INFINITY : card.summary.costUsd / card.summary.cases);
const acted = (card: Scorecard): number => card.summary.calibration?.actedOnAccuracy ?? Number.NEGATIVE_INFINITY;
const qualifies = (card: Scorecard): boolean => (card.summary.calibration?.coverage ?? 0) >= MIN_COVERAGE && (card.summary.calibration?.n ?? 0) >= MIN_CASES && card.summary.calibration?.actedOnAccuracy != null;
const isPerfect = (card: Scorecard): boolean => (card.summary.calibration?.coverage ?? 0) >= 1 - 1e-9 && acted(card) >= 1 - 1e-9;
const num = (n: number | null | undefined, digits = 2) => (n === null || n === undefined ? "n/a" : n.toFixed(digits));

export interface Proposal {
  default: EngineId;
  fallback: EngineId[];
  reason: string;
  measuredAt: string;
  measured: boolean;
  scorecard: Record<string, { n: number; accuracy: number | null; actedOnAccuracy: number | null; coverage: number | null; brier: number | null; ece: number | null; costPerCase: number | null }>;
}

export function proposeDefaults(pack: PackId, cards: Scorecard[], current: { default: EngineId; fallback: readonly EngineId[] }): Proposal {
  const mine = cards.filter((c) => c.pack === pack);
  const numbers: Proposal["scorecard"] = Object.fromEntries(
    mine.map((c) => [c.engine, { n: c.summary.calibration?.n ?? 0, accuracy: c.summary.calibration?.accuracy ?? null, actedOnAccuracy: c.summary.calibration?.actedOnAccuracy ?? null, coverage: c.summary.calibration?.coverage ?? null, brier: c.summary.calibration?.brier ?? null, ece: c.summary.calibration?.ece ?? null, costPerCase: Number.isFinite(costPerCase(c)) ? costPerCase(c) : null }]),
  );
  const measuredAt = mine.map((c) => c.at.slice(0, 10)).sort().at(-1) ?? "";
  // The fallback is a free engine before the metered one: Claude, then Codex, then Jev.
  const others = (chosen: EngineId): EngineId[] => [(["claude:haiku", "codex:luna", "jev"] as EngineId[]).find((e) => e !== chosen)!];
  if (mine.length < 2) return { default: current.default, fallback: [...current.fallback], reason: `unmeasured: ${mine.length} engine${mine.length === 1 ? "" : "s"} measured, two are needed`, measuredAt, measured: false, scorecard: numbers };

  const eligible = mine.filter(qualifies);
  if (eligible.length === 0) return { default: current.default, fallback: [...current.fallback], reason: `unmeasured: no engine reached coverage ${MIN_COVERAGE} on ${MIN_CASES} cases`, measuredAt, measured: false, scorecard: numbers };
  const best = Math.max(...eligible.map(acted));
  // An engine that acted on every case and was right on every one wins outright: one that ties on what it acted on,
  // but acted on less, has not shown the same (the user's choice of 2026-11-06).
  const perfect = eligible.filter(isPerfect);
  const tied = perfect.length > 0 ? perfect : eligible.filter((c) => best - acted(c) <= TIE_POINTS + 1e-9);
  // Accuracy first; among the tied, Jev (by far the cheapest engine, whatever cost a baseline recorded for it), then the cheaper one.
  const jevFirst = (card: Scorecard): number => (card.engine === "jev" ? 0 : 1);
  const chosen = [...tied].sort((a, b) => jevFirst(a) - jevFirst(b) || costPerCase(a) - costPerCase(b) || acted(b) - acted(a))[0]!;
  const tieNote = tied.length > 1 ? (chosen.engine === "jev" ? `, a tie within ${TIE_POINTS * 100} points that goes to Jev, the cheapest` : `, a tie within ${TIE_POINTS * 100} points settled by cost`) : "";
  const note = perfect.length > 0 ? `, it acted on every case and was right on every one${perfect.length > 1 ? (chosen.engine === "jev" ? "; so did others, and Jev is the cheapest" : "; so did others, and it is the cheaper") : ""}` : tieNote;
  const c = chosen.summary.calibration!;
  return {
    default: chosen.engine,
    fallback: others(chosen.engine),
    reason: `${chosen.engine}: acted-on accuracy ${num(c.actedOnAccuracy)} at coverage ${num(c.coverage)} (n ${c.n})${note}`,
    measuredAt,
    measured: true,
    scorecard: numbers,
  };
}

const percent = (n: number | null | undefined) => (n === null || n === undefined ? "n/a" : `${Math.round(n * 100)}%`);

/** `evals/scorecard.md`: one row per pack and engine, then each pack's proposed default and why. */
export function renderScorecard(cards: Scorecard[], proposals: Partial<Record<PackId, Proposal>>, now: Date): string {
  const median = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted.length === 0 ? 0 : sorted.length % 2 ? sorted[(sorted.length - 1) / 2]! : (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2;
  };
  const rows = cards.map((card) => {
    const c = card.summary.calibration!;
    const cost = costPerCase(card);
    return `| ${card.pack} | ${card.engine} | ${c.n} | ${percent(c.accuracy)} | ${percent(c.actedOnAccuracy)} | ${percent(c.coverage)} | ${num(c.brier, 3)} | ${num(c.ece, 3)} | ${Number.isFinite(cost) ? `$${cost.toFixed(4)}` : "n/a"} | ${(median(card.cases.map((x) => x.durationMs)) / 1000).toFixed(1)}s | ${card.at.slice(0, 10)} |`;
  });
  const packs = Object.keys(proposals).sort() as PackId[];
  const decided = packs.map((pack) => {
    const p = proposals[pack]!;
    return p.measured ? `| ${pack} | ${p.default} | ${p.reason} |` : `| ${pack} | ${p.default} | ${p.reason.startsWith("unmeasured") ? p.reason : `unmeasured: ${p.reason}`} |`;
  });
  return [
    "# Decision scorecard",
    "",
    `Generated ${now.toISOString().slice(0, 10)} by \`pnpm eval scorecard\` from \`evals/baselines/<engine>/<pack>.json\`. Do not edit by hand: re-run the baselines (docs/runbooks/calibrate-decisions.md).`,
    "",
    "## The rule",
    "",
    RULE,
    "",
    "## Every baseline",
    "",
    "| pack | engine | n | accuracy | acted-on accuracy | coverage | Brier | ECE | cost per case | p50 latency | measured at |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows,
    "",
    "## The default per slot",
    "",
    "| pack | default | why |",
    "| --- | --- | --- |",
    ...decided,
    "",
  ].join("\n");
}

/** The defaults file after the proposals: a measured pack takes its proposal (with the numbers behind it), an unmeasured one keeps its entry. Refuses what the contracts would. */
export function buildDefaultsFile(existing: Record<string, unknown>, proposals: Partial<Record<PackId, Proposal>>): Record<string, DecisionDefault> {
  const next: Record<string, unknown> = { ...existing };
  for (const [pack, p] of Object.entries(proposals) as Array<[PackId, Proposal]>) {
    if (p.measured) next[pack] = { default: p.default, fallback: p.fallback, reason: p.reason, measuredAt: p.measuredAt, scorecard: p.scorecard };
  }
  return DecisionDefaults.parse(next);
}
