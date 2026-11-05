// The Evidence Pack a change is shown by: assembled on the host from what the stages before Evidence
// left (the record, the plan, the browser run's manifest, Verify's findings, Build's out-of-map files).
// Pure: the caller reads the files and says what time it is.
import type { EvidencePack, Finding, Risk, TriageRecord, VerifyReport } from "@hardness/contracts";
import { existsSync } from "node:fs";

export interface EvidencePackInput {
  task: { title: string; description: string };
  record: TriageRecord | null;
  /** The approved plan's rollback and the risk the plan stage graded (the approval's `requested.risk.level`). */
  plan: { rollback?: string | null; risk: Risk | null };
  /** The manifest's rows matched to the approved cases; `test` is the row's first evidence path or the verifying approach. */
  scenarios: { text: string; criterion: string | null; result: EvidencePack["scenarios"][number]["result"]; test: string | null }[];
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
  now: Date;
}

const DEFAULT_ROLLBACK = "Revert the commit(s) on the branch; nothing else changes.";

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/** One paragraph: the goal, what the scenarios showed, the format and the risk. */
function summaryOf(input: EvidencePackInput, risk: Risk): string {
  const goal = (input.record?.goal || input.task.title).trim().replace(/[.\s]+$/, "");
  const count = (result: string) => input.scenarios.filter((s) => s.result === result).length;
  const shown =
    input.scenarios.length === 0
      ? "no browser scenarios were run"
      : `${plural(input.scenarios.length, "scenario")}: ${[`${count("pass")} passed`, ...(count("partial") ? [`${count("partial")} partial`] : []), ...(count("fail") ? [`${count("fail")} failed`] : []), ...(count("skipped") ? [`${count("skipped")} skipped`] : [])].join(", ")}`;
  return `${goal}. ${shown[0]!.toUpperCase()}${shown.slice(1)}. Shown as ${input.format}; risk ${risk}.`;
}

/** The v2.2 fields, from the Verify Report. */
function v2Of(report: VerifyReport, media: EvidencePack["media"]): Pick<EvidencePack, "results" | "findingsDetail" | "version"> & { media: EvidencePack["media"] } {
  const passed = report.e2e.scenarios.filter((s) => s.result === "pass").length;
  return {
    // `unit` stands for every check verifying ran until the checks are told apart (wave 12).
    results: {
      unit: report.tests.total > 0 ? report.tests : null,
      integration: null,
      e2e: report.e2e.verdict === null && report.e2e.scenarios.length === 0 ? null : { verdict: report.e2e.verdict, passed, total: report.e2e.scenarios.length },
      coverageDelta: report.coverageDelta ? { added: report.coverageDelta.total.added, covered: report.coverageDelta.total.covered } : null,
    },
    findingsDetail: report.findings.map((f) => ({ id: f.id ?? "", title: f.title, severity: f.severity, resolution: f.resolution?.status ?? null })),
    media: media.map((m) => (/^https?:\/\//i.test(m.url) ? m : { ...m, localPath: m.url })),
    version: 2,
  };
}

export function assembleEvidencePack(input: EvidencePackInput): EvidencePack {
  const risk = input.plan.risk ?? input.record?.risk ?? "medium";
  const v2 = input.verifyReport ? v2Of(input.verifyReport, input.media) : null;
  return {
    summary: summaryOf(input, risk),
    format: input.format,
    scenarios: input.scenarios.map((s) => ({ text: s.text, test: s.test, result: s.result })),
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
    at: input.now.toISOString(),
  };
}

/** Whether a pack may be published: every section there, its commit the PR's head, its media where it says. A local path is checked with `exists`. */
export function packComplete(pack: EvidencePack, headSha: string, exists: (path: string) => boolean = existsSync): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  if (pack.summary.trim() === "") problems.push("the summary is empty");
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
