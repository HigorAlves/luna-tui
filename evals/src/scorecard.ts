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

import type { Calibration } from "./calibration.ts";
import { type Scorecard, summarize } from "./grade.ts";

export const MIN_COVERAGE = 0.6;
export const MIN_CASES = 4;
export const TIE_POINTS = 0.02;
/** A default changes engine only when the winner's baseline has this many graded cases, and this many of them labelled. Under it the pack keeps its engine. */
export const MIN_CASES_TO_MOVE = 8;
export const MIN_LABELLED_TO_MOVE = 6;
/** A pack read answer by answer needs this many labelled answers before an engine qualifies. */
export const MIN_ANSWERS = 20;
const ALLOWED: EngineId[] = ["jev", "claude:haiku", "codex:luna"];

/** Packs the owner keeps on one engine whatever the numbers say, each with the day and the reason. The numbers are still measured and
 *  shown beside the choice; to let the rule decide again, remove the entry and run `pnpm eval defaults --write`. */
export const PINNED: Partial<Record<PackId, { engine: EngineId; since: string; why: string }>> = {
  worth_learning: { engine: "jev", since: "2026-11-06", why: "to try Jev on real cards first" },
  conversation_relation: { engine: "jev", since: "2026-11-06", why: "to try Jev on real cards first" },
  fix_scope: { engine: "jev", since: "2026-11-06", why: "to try Jev on real cards first" },
  escalation_reason: { engine: "jev", since: "2026-11-06", why: "to try Jev on real cards first" },
  ci_failure_class: { engine: "jev", since: "2026-11-06", why: "to try Jev on real cards first" },
};

export const RULE = `An engine qualifies with coverage >= ${MIN_COVERAGE} and n >= ${MIN_CASES}. The default is the qualifying engine with the highest acted-on accuracy; engines within ${TIE_POINTS * 100} points of it tie, and a tie goes to Jev when it is among them (by far the cheapest engine), else to the cheaper one (cost per case). A pack with fewer than two engines measured keeps its current default. An engine that acted on every case and was right on every one wins outright; among several such, Jev, else the cheaper. A pack the machine reads answer by answer is read the same way on its pool of answers (at least ${MIN_ANSWERS} labelled). A default moves only when the winner has ${MIN_CASES_TO_MOVE} graded cases and ${MIN_LABELLED_TO_MOVE} labelled; under that it keeps its engine. A pin of the owner is never moved by any of this.`;

/** A baseline's numbers recomputed from its own `cases[]`: the rule never trusts the summary a file carries, which a hand edit could have raised. Cost, time and turn
 *  figures stay as the file has them (a case's grade is what the rule reads); a baseline whose cases hold no grades keeps its summary as it is. */
export function withOwnSummary(card: Scorecard): Scorecard {
  if (!card.cases.some((c) => c.decision)) return card;
  const own = summarize(card.cases, card.pack);
  const { cases, passed, passRate, calibration, answers, perQuestion } = own;
  const summary = { ...card.summary, cases, passed, passRate, calibration } as Scorecard["summary"];
  if (answers) summary.answers = answers;
  else delete summary.answers;
  if (perQuestion) summary.perQuestion = perQuestion;
  else delete summary.perQuestion;
  return { ...card, summary };
}

/** Every decision pack's baselines under `evals/baselines/<engine>/<pack>.json`, those that parse. */
export function loadBaselines(evalsDir: string): Scorecard[] {
  const root = join(evalsDir, "baselines");
  if (!existsSync(root)) return [];
  const cards: Scorecard[] = [];
  for (const engineDir of readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory())) {
    for (const file of readdirSync(join(root, engineDir.name)).filter((f) => f.endsWith(".json"))) {
      try {
        const card = JSON.parse(readFileSync(join(root, engineDir.name, file), "utf8")) as Scorecard;
        if (card.schema === 1 && PACKS[card.pack]?.kind === "decision" && card.summary?.calibration && Array.isArray(card.cases)) cards.push(withOwnSummary(card));
      } catch {
        // A file that is not a scorecard is not a baseline.
      }
    }
  }
  return cards.sort((a, b) => a.pack.localeCompare(b.pack) || a.engine.localeCompare(b.engine));
}

/** The numbers a pack's rule reads: the whole-answer calibration, or for a pack read answer by answer the pool of its answers (null for a baseline from before). */
const readOf = (card: Scorecard): Calibration | null => (PACKS[card.pack]?.kind === "decision" && (PACKS[card.pack] as { measure?: string }).measure === "answer" ? card.summary.answers ?? null : card.summary.calibration ?? null);
const costPerCase = (card: Scorecard): number => (card.summary.costUsd === null || card.summary.cases === 0 ? Number.POSITIVE_INFINITY : card.summary.costUsd / card.summary.cases);
const acted = (card: Scorecard): number => readOf(card)?.actedOnAccuracy ?? Number.NEGATIVE_INFINITY;
const qualifies = (card: Scorecard): boolean => {
  const c = readOf(card);
  if (!c || (c.coverage ?? 0) < MIN_COVERAGE || c.actedOnAccuracy == null) return false;
  // A pack read answer by answer needs its graded cases and 20 labelled answers; a whole-answer pack its graded cases.
  return (card.summary.calibration?.n ?? 0) >= MIN_CASES && (readOf(card) === card.summary.calibration ? true : c.labelled >= MIN_ANSWERS);
};
const isPerfect = (card: Scorecard): boolean => (readOf(card)?.coverage ?? 0) >= 1 - 1e-9 && acted(card) >= 1 - 1e-9;
const num = (n: number | null | undefined, digits = 2) => (n === null || n === undefined ? "n/a" : n.toFixed(digits));

export interface Proposal {
  default: EngineId;
  fallback: EngineId[];
  reason: string;
  measuredAt: string;
  measured: boolean;
  measure?: "answer";
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

  const pin = PINNED[pack as PackId];
  if (pin) {
    const mineOf = mine.find((c) => c.engine === pin.engine)?.summary.calibration;
    const seen = mineOf ? ` (measured: acted-on accuracy ${num(mineOf.actedOnAccuracy)} at coverage ${num(mineOf.coverage)}, n ${mineOf.n})` : "";
    return { default: pin.engine, fallback: others(pin.engine), reason: `${pin.engine}: pinned by the owner on ${pin.since}, ${pin.why}${seen}`, measuredAt, measured: true, scorecard: numbers };
  }
  const byAnswer = (PACKS[pack] as { measure?: string }).measure === "answer";
  if (byAnswer && mine.every((c) => !c.summary.answers)) return { default: current.default, fallback: [...current.fallback], reason: "unmeasured: run before the per-answer measure", measuredAt, measured: false, scorecard: numbers };
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
  const c = readOf(chosen)!;
  const whole = chosen.summary.calibration!;
  if (whole.n < MIN_CASES_TO_MOVE) return { default: current.default, fallback: [...current.fallback], reason: `kept: ${chosen.engine} won on n ${whole.n}, ${MIN_CASES_TO_MOVE} are needed to move a default`, measuredAt, measured: false, scorecard: numbers };
  if (whole.labelled < MIN_LABELLED_TO_MOVE) return { default: current.default, fallback: [...current.fallback], reason: `kept: ${chosen.engine} won on ${whole.labelled} labelled, ${MIN_LABELLED_TO_MOVE} are needed to move a default`, measuredAt, measured: false, scorecard: numbers };
  return {
    default: chosen.engine,
    fallback: others(chosen.engine),
    reason: `${chosen.engine}: ${byAnswer ? "per answer, " : ""}acted-on accuracy ${num(c.actedOnAccuracy)} at coverage ${num(c.coverage)} (n ${c.n})${note}`,
    measuredAt,
    measured: true,
    scorecard: numbers,
    ...(byAnswer ? { measure: "answer" as const } : {}),
  };
}

/** The 90% Wilson interval of a proportion `p` over `n`, in whole percent. */
export function wilson(p: number, n: number): [number, number] {
  const z = 1.6448536269514722;
  const d = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / d;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, Math.round((centre - half) * 100)), Math.min(100, Math.round((centre + half) * 100))];
}
const withInterval = (c: Calibration): string => (c.actedOnAccuracy != null && c.acted ? `${percent(c.actedOnAccuracy)} (${wilson(c.actedOnAccuracy, c.acted).join("-")})` : percent(c.actedOnAccuracy));
const percent = (n: number | null | undefined) => (n === null || n === undefined ? "n/a" : `${Math.round(n * 100)}%`);

/** One row per pack, engine and question for every pack with more than one question that was read per answer. */
function perAnswerSection(cards: Scorecard[]): string[] {
  const rows = cards.flatMap((card) => Object.entries(card.summary.perQuestion ?? {}).filter(() => Object.keys(card.summary.perQuestion ?? {}).length > 1).map(([question, c]) => `| ${card.pack} | ${card.engine} | ${question} | ${c.labelled} | ${percent(c.accuracy)} | ${percent(c.actedOnAccuracy)} | ${percent(c.coverage)} | ${num(c.brier, 3)} |`));
  if (rows.length === 0) return [];
  return ["## Per answer", "", "| pack | engine | question | n labelled | accuracy | acted-on accuracy | coverage | Brier |", "| --- | --- | --- | --- | --- | --- | --- | --- |", ...rows, ""];
}

/** `evals/scorecard.md`: one row per pack and engine, then each pack's proposed default and why. */
export function renderScorecard(cards: Scorecard[], proposals: Partial<Record<PackId, Proposal>>, now: Date): string {
  const median = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted.length === 0 ? 0 : sorted.length % 2 ? sorted[(sorted.length - 1) / 2]! : (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2;
  };
  const rows = cards.map((card) => {
    const c = card.summary.calibration!;
    const cost = costPerCase(card);
    return `| ${card.pack} | ${card.engine} | ${c.n} | ${percent(c.accuracy)} | ${withInterval(c)} | ${percent(c.coverage)} | ${num(c.brier, 3)} | ${num(c.ece, 3)} | ${Number.isFinite(cost) ? `$${cost.toFixed(4)}` : "n/a"} | ${(median(card.cases.map((x) => x.durationMs)) / 1000).toFixed(1)}s | ${card.at.slice(0, 10)} |`;
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
    ...perAnswerSection(cards),
    "## The default per slot",
    "",
    "| pack | default | why |",
    "| --- | --- | --- |",
    ...decided,
    "",
  ].join("\n");
}

/** The defaults file after the proposals: a measured pack takes its proposal (with the numbers behind it), an unmeasured one keeps its entry. Refuses what the contracts would. */
export function buildDefaultsFile(existing: Record<string, unknown>, proposals: Partial<Record<PackId, Proposal>>, options: { except?: readonly string[] } = {}): Record<string, DecisionDefault> {
  const next: Record<string, unknown> = { ...existing };
  for (const [pack, p] of Object.entries(proposals) as Array<[PackId, Proposal]>) {
    if (options.except?.includes(pack)) continue;
    if (p.measured) next[pack] = { default: p.default, fallback: p.fallback, reason: p.reason, measuredAt: p.measuredAt, scorecard: p.scorecard, ...(p.measure ? { measure: p.measure } : {}) };
  }
  return DecisionDefaults.parse(next);
}
