// Proposes a repository's confidence bars from harvested ground truth, with the evidence behind every number. It reads records that have a truth
// (a person's or a fact's; an outcome only when asked), changes nothing, and prints the `luna.yaml` line a person could paste. Pure.
import { type DecisionPack, type DecisionPolicy, type DecisionRecord, PACKS, type PackId, confidenceOf } from "@hardness/contracts";

import { decisionPack, matches } from "./labels.ts";
import { kindsOf } from "./records.ts";
import { wilson } from "./scorecard.ts";

export const BARS = [0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95] as const;
export const MIN_ANSWERS = 20;
export const TARGET = 0.9;

export interface LabelledAnswer {
  confidence: number;
  right: boolean;
}

/** Per question, the answers a truth labels: the answer's confidence, and whether it matched the label. An outcome's label counts only with `withOutcome`. */
export function answersOf(pack: PackId, records: DecisionRecord[], options: { withOutcome?: boolean } = {}): Record<string, LabelledAnswer[]> {
  const decision = decisionPack(pack);
  const out: Record<string, LabelledAnswer[]> = {};
  if (!decision) return out;
  for (const record of records) {
    if (!record.truth) continue;
    const kinds = kindsOf(record.truth);
    for (const [question, label] of Object.entries(record.truth.label)) {
      const spec = decision.questions[question];
      const entry = record.answer[question];
      if (!spec || entry === undefined || entry === null || typeof entry !== "object") continue;
      if (kinds.get(question) === "outcome" && !options.withOutcome) continue;
      const right = matches(record.answer, { [question]: label as Record<string, unknown> });
      if (right === null) continue;
      (out[question] ??= []).push({ confidence: confidenceOf(spec, entry), right });
    }
  }
  return out;
}

export interface BarRow {
  bar: number;
  atOrAbove: number;
  share: number;
  right: number;
  accuracy: number | null;
  interval: [number, number] | null;
}

export interface BarProposal {
  n: number;
  candidates: BarRow[];
  proposal: { proceed: number; flag: number } | null;
  reason: string;
}

const round2 = (x: number): number => Math.round(x * 100) / 100;

/** The lowest bar whose acted-on accuracy reaches `target` with at least `floor` labelled answers at or above it; the flag bar sits the pack's own distance below. Fewer than `floor` answers: nothing. */
export function proposeBars(answers: LabelledAnswer[], today: { proceed: number; flag: number }, options: { target?: number; floor?: number } = {}): BarProposal {
  const target = options.target ?? TARGET;
  const floor = options.floor ?? MIN_ANSWERS;
  const candidates: BarRow[] = BARS.map((bar) => {
    const above = answers.filter((a) => a.confidence >= bar);
    const right = above.filter((a) => a.right).length;
    const accuracy = above.length === 0 ? null : right / above.length;
    return { bar, atOrAbove: above.length, share: answers.length === 0 ? 0 : above.length / answers.length, right, accuracy, interval: accuracy === null ? null : wilson(accuracy, above.length) };
  });
  if (answers.length < floor) return { n: answers.length, candidates, proposal: null, reason: `too few: ${answers.length} of ${floor} labelled answers` };
  const pick = candidates.find((c) => c.atOrAbove >= floor && c.accuracy !== null && c.accuracy >= target);
  if (!pick) return { n: answers.length, candidates, proposal: null, reason: `no bar from ${BARS[0]} to ${BARS.at(-1)} reaches ${Math.round(target * 100)}% with ${floor} answers at or above it` };
  return { n: answers.length, candidates, proposal: { proceed: pick.bar, flag: round2(Math.max(0, pick.bar - (today.proceed - today.flag))) }, reason: `the lowest bar at ${Math.round(target * 100)}% or better with ${floor} or more answers at or above it` };
}

const pct = (x: number | null): string => (x === null ? "-" : `${Math.round(x * 100)}%`);

/** The report for one pack: per question the evidence, the bar today, the proposal; a pin beside the numbers. Never a record's context. */
export function renderBars(pack: PackId, records: DecisionRecord[], options: { today?: DecisionPolicy; pin?: { engine: string; since: string; why: string }; target?: number; withOutcome?: boolean } = {}): string[] {
  const decision = PACKS[pack] as DecisionPack;
  const today = options.today ?? decision.policy;
  const answers = answersOf(pack, records, options.withOutcome ? { withOutcome: true } : {});
  const lines = [`${pack}: bars from ground truth (proposed, not applied)`];
  if (options.pin) lines.push(`  pinned on ${options.pin.engine} since ${options.pin.since} (${options.pin.why}): this tool never moves the engine, it only proposes bars`);
  const yaml: string[] = [];
  for (const question of Object.keys(decision.questions)) {
    const list = answers[question] ?? [];
    const bar = today[question] ?? { proceed: 0.7, flag: 0.5 };
    const out = proposeBars(list, bar, options.target === undefined ? {} : { target: options.target });
    lines.push(`  ${question}: ${list.length} labelled answers; the bar today is proceed ${bar.proceed}, flag ${bar.flag}`);
    if (list.length > 0) {
      lines.push("    bar   at or above   share   right   acted-on accuracy (90%)");
      for (const c of out.candidates) lines.push(`    ${c.bar.toFixed(2)}  ${String(c.atOrAbove).padStart(11)}   ${pct(c.share).padStart(5)}   ${String(c.right).padStart(5)}   ${pct(c.accuracy)}${c.interval ? ` (${c.interval[0]}-${c.interval[1]})` : ""}`);
    }
    if (out.proposal) {
      lines.push(`    proposal: proceed ${out.proposal.proceed}, flag ${out.proposal.flag}: ${out.reason}`);
      yaml.push(`decisions.${pack}.${question}: { proceed: ${out.proposal.proceed}, flag: ${out.proposal.flag} }`);
    } else lines.push(`    ${out.reason}; nothing proposed`);
  }
  if (yaml.length > 0) lines.push("", "luna.yaml lines a person could paste (proposed, not applied):", ...yaml.map((l) => `  ${l}`));
  return lines;
}
