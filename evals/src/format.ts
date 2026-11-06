// The scorecard and the diff as the terminal prints them. Pure.
import type { CaseResult, Scorecard, ScorecardDiff } from "./grade.ts";

const pct = (rate: number) => `${Math.round(rate * 100)}%`;
const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
const usd = (cost: number | null) => (cost === null ? "cost n/a" : `$${cost.toFixed(4)}`);
const share = (rate: number | null) => (rate === null ? "n/a" : pct(rate));
const fixed = (n: number | null, digits = 3) => (n === null ? "n/a" : n.toFixed(digits));
const signed = (n: number, digits = 2) => `${n >= 0 ? "+" : ""}${n.toFixed(digits)}`;

function caseLines(result: CaseResult): string[] {
  const checks = [result.schema, ...result.checks];
  const passed = checks.filter((c) => c.pass).length;
  const judge = result.judge === null ? "judge skipped" : "score" in result.judge ? `judge ${result.judge.score.toFixed(2)}` : "judge failed";
  const d = result.decision;
  const decision = d ? `  label ${d.correct === null ? "n/a" : d.correct ? "right" : "wrong"} · conf ${d.confidence.toFixed(2)} ${d.verdict}` : "";
  const trial = result.trial && result.trial > 1 ? `#${result.trial}` : "";
  const head = `  ${result.pass ? "PASS" : "FAIL"}  ${`${result.id}${trial}`.padEnd(22)} checks ${passed}/${checks.length}${decision}  ${judge}  ${result.turns} turn(s)  ${secs(result.durationMs)}  ${usd(result.costUsd)}`;
  const failures = checks.filter((c) => !c.pass).map((c) => `        x ${c.check}: ${c.detail}`);
  const judged = result.judge === null ? [] : "error" in result.judge ? [`        judge: ${result.judge.error}`] : result.pass ? [] : result.judge.reasons.map((r) => `        judge: ${r}`);
  return [head, ...failures, ...judged];
}

export function formatScorecard(card: Scorecard): string {
  const s = card.summary;
  const judge = card.judge ? `judge ${card.judge}` : "no judge";
  const judgeCost = s.judgeCostUsd === null ? "" : ` (judge ${usd(s.judgeCostUsd)})`;
  const c = s.calibration;
  const calibration = c
    ? [`  accuracy ${share(c.accuracy)} (${c.labelled} labelled of ${c.n}) · acted-on ${share(c.actedOnAccuracy)} · coverage ${share(c.coverage)} · Brier ${fixed(c.brier)} · ECE ${fixed(c.ece)} · mean confidence ${fixed(c.meanConfidence, 2)} · overconfident ${c.overconfident}${card.trials && card.trials > 1 ? ` · ${card.trials} trials` : ""}`]
    : [];
  return [
    `${card.pack} on ${card.engine}${card.model ? ` (${card.model})` : ""} · ${judge}`,
    ...card.cases.flatMap(caseLines),
    `  pass ${s.passed}/${s.cases} (${pct(s.passRate)}) · judge ${s.meanJudgeScore === null ? "n/a" : s.meanJudgeScore.toFixed(2)} · ${s.meanTurns.toFixed(1)} turns · ${secs(s.meanDurationMs)} mean · ${usd(s.costUsd)}${judgeCost}`,
    ...calibration,
  ].join("\n");
}

export function formatDiff(diff: ScorecardDiff, label = `${diff.next.engine} vs ${diff.base.engine}`): string {
  const parts = [
    `pass rate ${signed(diff.passRate * 100, 0)} pts`,
    `judge ${diff.meanJudgeScore === null ? "n/a" : signed(diff.meanJudgeScore)}`,
    `turns ${signed(diff.meanTurns, 1)}`,
    `duration ${signed(diff.meanDurationMs / 1000, 1)}s`,
    `cost ${diff.costUsd === null ? "n/a" : `${diff.costUsd >= 0 ? "+" : "-"}$${Math.abs(diff.costUsd).toFixed(4)}`}`,
  ];
  const k = diff.calibration;
  if (k) parts.push(`accuracy ${k.accuracy == null ? "n/a" : `${signed(k.accuracy * 100, 0)} pts`}`, `acted-on ${k.actedOnAccuracy == null ? "n/a" : `${signed(k.actedOnAccuracy * 100, 0)} pts`}`, `coverage ${k.coverage == null ? "n/a" : `${signed(k.coverage * 100, 0)} pts`}`, `Brier ${k.brier == null ? "n/a" : signed(k.brier, 3)}`, `ECE ${k.ece == null ? "n/a" : signed(k.ece, 3)}`);
  const lines = [`${label} over ${diff.common} case(s): ${parts.join(" · ")}`];
  for (const flip of diff.flips) lines.push(`  flipped: ${flip.id} (${flip.base ? "pass" : "fail"} -> ${flip.next ? "pass" : "fail"})`);
  if (diff.onlyBase.length > 0) lines.push(`  not run this time: ${diff.onlyBase.join(", ")}`);
  if (diff.onlyNext.length > 0) lines.push(`  new since: ${diff.onlyNext.join(", ")}`);
  return lines.join("\n");
}
