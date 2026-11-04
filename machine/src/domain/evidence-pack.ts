// The Evidence Pack a change is shown by: assembled on the host from what the stages before Evidence
// left (the record, the plan, the browser run's manifest, Verify's findings, Build's out-of-map files).
// Pure: the caller reads the files and says what time it is.
import type { EvidencePack, Finding, Risk, TriageRecord } from "@hardness/contracts";

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

export function assembleEvidencePack(input: EvidencePackInput): EvidencePack {
  const risk = input.plan.risk ?? input.record?.risk ?? "medium";
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
    media: input.media,
    ...(input.video !== undefined ? { video: input.video } : {}),
    ...(input.note ? { note: input.note } : {}),
    at: input.now.toISOString(),
  };
}
