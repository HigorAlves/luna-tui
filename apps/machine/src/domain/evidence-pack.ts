// The Evidence Pack a change is shown by: assembled on the host from what the stages before Evidence
// left (the record, the plan, the browser run's manifest, Verify's findings, Build's out-of-map files).
// Pure: the caller reads the files and says what time it is.
import type { BuildReport, EvidencePack, Finding, Risk, ScenarioLayer, TriageRecord, VerifyReport } from "@hardness/contracts";
import { existsSync } from "node:fs";

export interface EvidencePackInput {
  task: { title: string; description: string };
  record: TriageRecord | null;
  /** The approved plan's rollback and the risk the plan stage graded (the approval's `requested.risk.level`). */
  plan: { rollback?: string | null; risk: Risk | null };
  /** The manifest's rows matched to the approved cases; `test` is the row's first evidence path or the verifying approach. */
  scenarios: { text: string; criterion: string | null; result: EvidencePack["scenarios"][number]["result"]; test: string | null; /** The scenario's id and layer, from the approved plan: results are counted by layer and the Build Report's tests are found by id. */ id?: string; layer?: ScenarioLayer | null }[];
  findings: Finding[];
  outOfMap: { path: string; reason: string }[];
  media: EvidencePack["media"];
  commitSha: string;
  format: EvidencePack["format"];
  /** The QA target's URL, else the steps file's path, else "run the checks in luna.yaml". */
  howToVerify: string;
  note?: string;
  video?: EvidencePack["video"];
  /** The Verify Report (ci_watch's passing finish) when one exists: the pack then carries the v2 fields. */
  verifyReport?: VerifyReport | null;
  /** The Build Report: the diff summary, and which tagged test proves which scenario. */
  buildReport?: BuildReport | null;
  /** The pack this one replaces, when the card had one: the revision counts on from it. */
  previous?: { revision?: number } | null;
  now: Date;
}

export const DEFAULT_ROLLBACK = "Revert the commit(s) on the branch; nothing else changes.";
export const DEFAULT_HOW_TO_VERIFY = "run the checks in luna.yaml";
export const SUMMARY_MAX_WORDS = 200;

/** `text` cut at a word boundary to at most `max` words. */
function capWords(text: string, max: number): string {
  const words = text.trim().split(/\s+/).filter((w) => w !== "");
  return words.length <= max ? text.trim() : words.slice(0, max).join(" ");
}
const wordCount = (text: string): number => text.trim().split(/\s+/).filter((w) => w !== "").length;

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/** One paragraph: the goal, what the scenarios showed, the format and the risk. */
function summaryOf(input: EvidencePackInput, risk: Risk): string {
  const goal = (input.record?.goal || input.task.title).trim().replace(/[.\s]+$/, "");
  const count = (result: string) => input.scenarios.filter((s) => s.result === result).length;
  const shown =
    input.scenarios.length === 0
      ? "no browser scenarios were run"
      : `${plural(input.scenarios.length, "scenario")}: ${[`${count("pass")} passed`, ...(count("partial") ? [`${count("partial")} partial`] : []), ...(count("fail") ? [`${count("fail")} failed`] : []), ...(count("skipped") ? [`${count("skipped")} skipped`] : []), ...(count("not_run") ? [`${count("not_run")} not run`] : [])].join(", ")}`;
  const tail = `${shown[0]!.toUpperCase()}${shown.slice(1)}. Shown as ${input.format}; risk ${risk}.`;
  // At most 200 words: the goal gives way, at a word, and the counts and the format stay.
  const room = Math.max(SUMMARY_MAX_WORDS - wordCount(tail) - 1, 1);
  return wordCount(`${goal}. ${tail}`) <= SUMMARY_MAX_WORDS ? `${goal}. ${tail}` : `${capWords(goal, room)}. ${tail}`;
}

/** The v2.2 fields, from the Verify Report. */
function v2Of(report: VerifyReport, media: EvidencePack["media"], input: EvidencePackInput): Pick<EvidencePack, "results" | "findingsDetail" | "version"> & { media: EvidencePack["media"] } {
  // The browser run's rows when the report has them, else the manifest's scenarios.
  const e2eRows = report.e2e.rows ?? report.e2e.scenarios;
  const passed = e2eRows.filter((s) => s.result === "pass").length;
  // By layer: the approved scenarios of that layer whose tagged test ended `after: pass`. With no scenario carrying a layer, `unit` is every check Verify ran.
  const layered = input.scenarios.some((s) => s.layer);
  const byLayer = (layer: ScenarioLayer): { passed: number; total: number } | null => {
    const mine = input.scenarios.filter((s) => s.layer === layer);
    if (mine.length === 0) return null;
    const done = mine.filter((s) => s.id !== undefined && input.buildReport?.tests.some((t) => t.scenario === s.id && t.after === "pass")).length;
    return { passed: done, total: mine.length };
  };
  return {
    results: {
      unit: layered ? byLayer("unit") : report.tests.total > 0 ? report.tests : null,
      integration: layered ? byLayer("integration") : null,
      e2e: report.e2e.verdict === null && e2eRows.length === 0 ? null : { verdict: report.e2e.verdict, passed, total: e2eRows.length },
      coverageDelta: report.coverageDelta ? { added: report.coverageDelta.total.added, covered: report.coverageDelta.total.covered } : null,
    },
    findingsDetail: report.findings.map((f) => ({ id: f.id ?? "", title: f.title, severity: f.severity, resolution: f.resolution?.status ?? null, ...(f.resolution?.inferred ? { inferred: true } : {}) })),
    media: media.map((m) => (/^https?:\/\//i.test(m.url) ? m : { ...m, localPath: m.url })),
    version: 2,
  };
}

export function assembleEvidencePack(input: EvidencePackInput): EvidencePack {
  const risk = input.plan.risk ?? input.record?.risk ?? "medium";
  const v2 = input.verifyReport ? v2Of(input.verifyReport, input.media, input) : null;
  const built = input.buildReport ?? null;
  return {
    summary: summaryOf(input, risk),
    format: input.format,
    // The scenario's tagged test file when the Build Report names one, else the row's first artifact.
    scenarios: input.scenarios.map((s) => ({ text: s.text, test: (s.id !== undefined ? built?.tests.find((t) => t.scenario === s.id)?.file : undefined) ?? s.test, result: s.result })),
    findings: input.findings.map((f) => `${f.severity}: ${f.title} (${f.path}:${f.line})`),
    outOfMap: input.outOfMap.map((o) => `${o.path}: ${o.reason}`),
    risk,
    rollback: input.plan.rollback?.trim() || DEFAULT_ROLLBACK,
    howToVerify: input.howToVerify,
    commitSha: input.commitSha,
    media: v2 ? v2.media : input.media,
    ...(v2 ? { results: v2.results, findingsDetail: v2.findingsDetail, version: v2.version } : {}),
    ...(input.video !== undefined ? { video: input.video } : {}),
    ...(input.note ? { note: input.note } : {}),
    ...(built ? { diffSummary: { what: built.summary?.what ?? "", why: built.summary?.why ?? "", files: built.diffSummary.files, added: built.diffSummary.added, removed: built.diffSummary.removed } } : {}),
    revision: input.previous ? (input.previous.revision ?? 1) + 1 : 1,
    at: input.now.toISOString(),
  };
}

/** Whether a pack may be published: every section there, its commit the PR's head, its media where it says. A local path is checked with `exists`. */
export function packComplete(pack: EvidencePack, headSha: string, exists: (path: string) => boolean = existsSync): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  if (pack.summary.trim() === "") problems.push("the summary is empty");
  else if (wordCount(pack.summary) > SUMMARY_MAX_WORDS) problems.push(`the summary is over ${SUMMARY_MAX_WORDS} words`);
  if (pack.format !== "text" && pack.scenarios.length === 0) problems.push("no scenarios: a captures or video pack must show at least one");
  if (pack.rollback.trim() === "") problems.push("the rollback is empty");
  if (pack.howToVerify.trim() === "") problems.push("how to verify is empty");
  if (pack.commitSha !== headSha) problems.push(`the pack shows ${pack.commitSha.slice(0, 7)} but the PR head is ${headSha.slice(0, 7)}`);
  for (const m of pack.media) {
    if (m.url.trim() === "") problems.push(`the media ${m.label} has no url`);
    else if (!/^https?:\/\//i.test(m.url) && !exists(m.url)) problems.push(`the media ${m.label} is missing on disk`);
  }
  return { ok: problems.length === 0, problems };
}

/** Fixes what a script can in a pack `packComplete` found wanting, and notes each repair on the pack. Pure. `unfixed` is what it cannot fix: a commit that is not the head is the
 *  pack's staleness, never repaired here. */
export function repairPack(pack: EvidencePack, problems: readonly string[], exists: (path: string) => boolean = existsSync): { pack: EvidencePack; unfixed: string[] } {
  if (problems.length === 0) return { pack, unfixed: [] };
  const repairs: string[] = [];
  const unfixed: string[] = [];
  let next: EvidencePack = { ...pack };
  const rebuiltSummary = (): string => {
    const count = (result: string) => next.scenarios.filter((s) => s.result === result).length;
    const shown = next.scenarios.length === 0 ? "no scenarios" : `${plural(next.scenarios.length, "scenario")}, ${count("pass")} passed`;
    return `Evidence for ${next.commitSha.slice(0, 7)}: ${shown}. Shown as ${next.format}; risk ${next.risk}.`;
  };
  for (const problem of problems) {
    if (/^the summary is empty/.test(problem)) {
      next = { ...next, summary: rebuiltSummary() };
      repairs.push("the summary was empty and was rebuilt");
    } else if (/^the summary is over/.test(problem)) {
      next = { ...next, summary: capWords(next.summary, SUMMARY_MAX_WORDS) };
      repairs.push("the summary was cut to 200 words");
    } else if (/^the rollback is empty/.test(problem)) {
      next = { ...next, rollback: DEFAULT_ROLLBACK };
      repairs.push("the rollback was empty and took the default");
    } else if (/^how to verify is empty/.test(problem)) {
      next = { ...next, howToVerify: DEFAULT_HOW_TO_VERIFY };
      repairs.push("how to verify was empty and took the default");
    } else if (/^the media .* (has no url|is missing on disk)/.test(problem)) {
      const dropped = next.media.filter((m) => m.url.trim() === "" || (!/^https?:\/\//i.test(m.url) && !exists(m.url)));
      if (dropped.length > 0) {
        next = { ...next, media: next.media.filter((m) => !dropped.includes(m)) };
        repairs.push(`dropped ${dropped.map((m) => m.label).join(", ")}: not on disk`);
      }
    } else if (/^no scenarios/.test(problem)) {
      next = { ...next, format: "text" };
      repairs.push("no scenario was shown, so the pack is text");
    } else {
      unfixed.push(problem);
    }
  }
  if (repairs.length === 0) return { pack, unfixed };
  const added = `repaired: ${[...new Set(repairs)].join("; ")}`;
  return { pack: { ...next, note: next.note ? `${next.note}; ${added}` : added }, unfixed };
}
