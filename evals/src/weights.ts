// Proposes the priority weights and bands from the priority files the machine keeps (a person's level against the model's sub-scores). It scores today's
// settings by how often the computed level equals the person's, tries every whole-number weight 0 to 5 with the bands moved in steps of 1, and prints the
// best set with its agreement. A knock-out card is left out: its level did not come from the weights. Pure; it changes nothing.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { type Bands, SCORING_DEFAULTS, type SubScoreKey, type SubScores, type Weights } from "@hardness/contracts";

export interface PriorityFile {
  subScores: SubScores;
  personLevel: string;
  machineLevel: string | null;
  knockOut: string | null;
}

const KEYS = Object.keys(SCORING_DEFAULTS.weights) as SubScoreKey[];
const MIN_FILES = 30;
const MIN_CHANGED = 10;
const BAND_SPAN = 4;

/** The files' JSON texts as entries: what does not parse, or holds no five numeric sub-scores or no level, is skipped. */
export function parsePriorityFiles(texts: string[]): PriorityFile[] {
  const out: PriorityFile[] = [];
  for (const text of texts) {
    try {
      const body = JSON.parse(text) as { subScores?: Record<string, unknown> | null; personLevel?: unknown; machineLevel?: unknown; knockOut?: unknown };
      const s = body.subScores;
      if (!s || typeof body.personLevel !== "string" || !KEYS.every((k) => typeof s[k] === "number")) continue;
      out.push({ subScores: Object.fromEntries(KEYS.map((k) => [k, s[k] as number])) as SubScores, personLevel: body.personLevel, machineLevel: typeof body.machineLevel === "string" ? body.machineLevel : null, knockOut: typeof body.knockOut === "string" ? body.knockOut : null });
    } catch {
      // Not a priority file.
    }
  }
  return out;
}

const levelOf = (total: number, b: Bands): string => (total >= b.P0 ? "P0" : total >= b.P1 ? "P1" : total >= b.P2 ? "P2" : "P3");
const totalOf = (s: SubScores, w: Weights): number => KEYS.reduce((sum, k) => sum + w[k] * s[k], 0);

export interface WeightSet {
  weights: Weights;
  bands: Bands;
  agreement: number;
}

export interface WeightProposal {
  /** Files that count: a knock-out is out. */
  used: number;
  /** Of those, the ones where a person's level is not the one the machine gave. */
  changed: number;
  today: WeightSet;
  proposal: (WeightSet & { changes: number }) | null;
  reason: string;
}

export function proposeWeights(files: PriorityFile[], options: { weights?: Weights; bands?: Bands } = {}): WeightProposal {
  const weights: Weights = options.weights ?? { ...SCORING_DEFAULTS.weights };
  const bands: Bands = options.bands ?? { ...SCORING_DEFAULTS.bands };
  const used = files.filter((f) => f.knockOut === null);
  const changed = used.filter((f) => f.machineLevel !== null && f.machineLevel !== f.personLevel).length;
  const agree = (w: Weights, b: Bands): number => (used.length === 0 ? 0 : used.filter((f) => levelOf(totalOf(f.subScores, w), b) === f.personLevel).length / used.length);
  const today: WeightSet = { weights, bands, agreement: agree(weights, bands) };
  if (used.length < MIN_FILES) return { used: used.length, changed, today, proposal: null, reason: `too few: ${used.length} of ${MIN_FILES} priority files` };
  if (changed < MIN_CHANGED) return { used: used.length, changed, today, proposal: null, reason: `too few: ${changed} of ${MIN_CHANGED} files where a person changed the level` };
  let best: { w: Weights; b: Bands; hits: number; distance: number } | null = null;
  const todayHits = Math.round(today.agreement * used.length);
  const range = [0, 1, 2, 3, 4, 5];
  for (const who of range) for (const what of range) for (const impact of range) for (const time of range) for (const demand of range) {
    const w: Weights = { who, what, impact, time, demand };
    if (who + what + impact + time + demand === 0) continue;
    const totals = used.map((f) => totalOf(f.subScores, w));
    const wd = KEYS.reduce((sum, k) => sum + Math.abs(w[k] - weights[k]), 0);
    for (let p2 = bands.P2 - BAND_SPAN; p2 <= bands.P2 + BAND_SPAN; p2++) for (let p1 = Math.max(p2, bands.P1 - BAND_SPAN); p1 <= bands.P1 + BAND_SPAN; p1++) for (let p0 = Math.max(p1, bands.P0 - BAND_SPAN); p0 <= bands.P0 + BAND_SPAN; p0++) {
      const b: Bands = { P0: p0, P1: p1, P2: p2 };
      let hits = 0;
      for (let i = 0; i < used.length; i++) if (levelOf(totals[i]!, b) === used[i]!.personLevel) hits++;
      const distance = wd + Math.abs(p0 - bands.P0) + Math.abs(p1 - bands.P1) + Math.abs(p2 - bands.P2);
      if (!best || hits > best.hits || (hits === best.hits && distance < best.distance)) best = { w, b, hits, distance };
    }
  }
  if (!best || best.hits <= todayHits) return { used: used.length, changed, today, proposal: null, reason: `today's weights and bands already agree best: ${todayHits} of ${used.length} cards` };
  const changes = used.filter((f) => levelOf(totalOf(f.subScores, best!.w), best!.b) !== levelOf(totalOf(f.subScores, weights), bands)).length;
  return { used: used.length, changed, today, proposal: { weights: best.w, bands: best.b, agreement: best.hits / used.length, changes }, reason: "the whole-number weights 0 to 5 and the bands within 4 of today's that agree with the person most often" };
}

const wText = (w: Weights): string => `{ ${KEYS.map((k) => `${k}: ${w[k]}`).join(", ")} }`;
const bText = (b: Bands): string => `{ P0: ${b.P0}, P1: ${b.P1}, P2: ${b.P2} }`;
const pct = (x: number): string => `${Math.round(x * 100)}%`;

/** The report: the counts, today's agreement, the best set and what it would change, the luna.yaml lines marked proposed. No card text. */
export function renderWeights(out: WeightProposal): string[] {
  const lines = [`priority weights from ${out.used} files (${out.changed} where a person changed the level); proposed, not applied`, `  today: weights ${wText(out.today.weights)}, bands ${bText(out.today.bands)}: agrees with the person on ${pct(out.today.agreement)}`];
  if (!out.proposal) return [...lines, `  ${out.reason}; nothing proposed`];
  lines.push(`  best: weights ${wText(out.proposal.weights)}, bands ${bText(out.proposal.bands)}: agrees on ${pct(out.proposal.agreement)}; it would change the level of ${out.proposal.changes} of ${out.used} cards`, "", "luna.yaml lines a person could paste (proposed, not applied):", `  scoring.weights: ${wText(out.proposal.weights)}`, `  scoring.bands: ${bText(out.proposal.bands)}`);
  return lines;
}

/** The priority files under `<stateDir>/ground-truth/priority/`, those of one machine (`triage`, `ticket`, `conversation`) when asked. Reads only; the files are the machine's. */
export function readPriorityFiles(stateDir: string, machine?: string): PriorityFile[] {
  const dir = join(stateDir, "ground-truth", "priority");
  if (!existsSync(dir)) return [];
  return parsePriorityFiles(readdirSync(dir).filter((n) => n.endsWith(".json") && (!machine || n.startsWith(`${machine}-`))).map((n) => readFileSync(join(dir, n), "utf8")));
}
