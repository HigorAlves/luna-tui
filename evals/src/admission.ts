// Whether an engine may join a pack that reads images (RFC 0013): its eval matches the Claude baseline within the scorecard's tie, on enough cases.
import type { EngineId, PackId } from "@hardness/contracts";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { baselinePath, engineSlug } from "./cases.ts";
import { MIN_CASES_TO_MOVE, TIE_POINTS } from "./scorecard.ts";

export interface AdmissionCard {
  n: number;
  passRate: number;
  recall?: number;
  falseBlockerRate?: number;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const points = `${Math.round(TIE_POINTS * 100)} points`;

export function admit(candidate: AdmissionCard, baseline: AdmissionCard): { pass: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (candidate.n < MIN_CASES_TO_MOVE) reasons.push(`n ${candidate.n}, ${MIN_CASES_TO_MOVE} are needed`);
  if (candidate.passRate < baseline.passRate - TIE_POINTS) reasons.push(`pass rate ${pct(candidate.passRate)} is more than ${points} under ${pct(baseline.passRate)}`);
  if (candidate.recall !== undefined && baseline.recall !== undefined && candidate.recall < baseline.recall - TIE_POINTS) reasons.push(`recall ${pct(candidate.recall)} is more than ${points} under ${pct(baseline.recall)}`);
  if (candidate.falseBlockerRate !== undefined && baseline.falseBlockerRate !== undefined && candidate.falseBlockerRate > baseline.falseBlockerRate + TIE_POINTS) reasons.push(`false blockers ${pct(candidate.falseBlockerRate)} are more than ${points} over ${pct(baseline.falseBlockerRate)}`);
  return { pass: reasons.length === 0, reasons };
}

export const admissionPath = (evalsDir: string, engine: EngineId, pack: PackId): string => join(evalsDir, "baselines", engineSlug(engine), `${pack}.admission.json`);

/** The admission card of a saved baseline: its summary, and the parity grader's recall and false-blocker rate when the summary records them. */
export function cardOf(scorecard: { summary: { cases: number; passRate: number; recall?: number; falseBlockerRate?: number } }): AdmissionCard {
  const { cases, passRate, recall, falseBlockerRate } = scorecard.summary;
  return { n: cases, passRate, ...(recall !== undefined && { recall }), ...(falseBlockerRate !== undefined && { falseBlockerRate }) };
}

/** What is wrong with the non-Claude engines a pack that reads images allows: each has no passing admission record against a Claude engine. */
export function unadmitted(pack: { id: PackId; engines: { allowed: EngineId[] } }, evalsDir: string): string[] {
  const problems: string[] = [];
  for (const engine of pack.engines.allowed.filter((e) => !e.startsWith("claude:"))) {
    const file = admissionPath(evalsDir, engine, pack.id);
    if (!existsSync(file)) {
      problems.push(`${pack.id} allows ${engine} with no ${file}`);
      continue;
    }
    const record = JSON.parse(readFileSync(file, "utf8")) as { pack?: string; engine?: string; pass?: boolean; against?: string };
    if (record.pack !== pack.id || record.engine !== engine || record.pass !== true || !record.against?.startsWith("claude:")) problems.push(`${file} is not a pass of ${engine} on ${pack.id} against a Claude engine`);
  }
  return problems;
}

export interface AdmissionRecord {
  pack: PackId;
  engine: EngineId;
  against: EngineId;
  at: string;
  pass: boolean;
  reasons: string[];
  candidate: AdmissionCard;
  baseline: AdmissionCard;
}

/** `pnpm eval admit`: both saved baselines read, the verdict and its lines. `code` is 0 on a pass, 1 on a fail, 2 when a baseline or the comparison is missing. */
export function admission(evalsDir: string, ask: { pack: PackId; engine: EngineId; against: EngineId; at?: string }): { code: 0 | 1 | 2; lines: string[]; record?: AdmissionRecord } {
  if (!ask.against.startsWith("claude:")) return { code: 2, lines: [`--against must be a Claude engine, not ${ask.against}`] };
  const files = [ask.engine, ask.against].map((engine) => baselinePath(evalsDir, engine, ask.pack));
  const absent = files.filter((file) => !existsSync(file));
  if (absent.length > 0) return { code: 2, lines: absent.map((file) => `no baseline ${file}: run \`pnpm eval --pack ${ask.pack} --engine <e> --save-baseline\` first`) };
  const [candidate, baseline] = files.map((file) => cardOf(JSON.parse(readFileSync(file, "utf8")))) as [AdmissionCard, AdmissionCard];
  const { pass, reasons } = admit(candidate, baseline);
  const record: AdmissionRecord = { pack: ask.pack, engine: ask.engine, against: ask.against, at: ask.at ?? new Date().toISOString(), pass, reasons, candidate, baseline };
  const lines = pass ? [`admitted: ${ask.engine} on ${ask.pack} (n ${candidate.n}, pass ${pct(candidate.passRate)} against ${ask.against} ${pct(baseline.passRate)})`] : reasons.map((r) => `refused: ${ask.engine} on ${ask.pack}: ${r}`);
  return { code: pass ? 0 : 1, lines, record };
}
