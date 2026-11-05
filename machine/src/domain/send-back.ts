// What a card sent back to Build from the browser run or from Evidence carries: findings of the same shape as Verify's, one per failed
// scenario with the judged cause, and one for what Evidence is missing. Everything is text a model or a container wrote: flattened and capped here.
import { type Finding, findingId } from "@hardness/contracts";

import { safe } from "./evidence-markdown.ts";

const TITLE_CAP = 160;
const TEXT_CAP = 600;
const ARTIFACTS_MAX = 8;
/** An artifact is named, never opened: a plain file name only, no path, no traversal. */
const ARTIFACT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export interface ScenarioRow {
  text: string;
  criterion?: string | null | undefined;
  result: string;
  evidence: readonly string[];
}

const flat = (text: string, cap: number): string => safe(text).slice(0, cap);

function finding(title: string, body: string, criterion: string | null): Finding {
  const base = { path: "", line: 0, start_line: null, severity: "blocker", category: "correctness" as const, title, body, suggestion_code: null, criterion_ref: criterion, confidence: 1 };
  return { ...base, id: findingId(base) };
}

/** One finding per scenario that failed or went partly: its expectation, what the run saw, its artifacts by name and the judged cause (`null` when none was judged). */
export function scenarioFindings(rows: readonly ScenarioRow[], seen: string, cause: string | null): Finding[] {
  return rows
    .filter((row) => row.result === "fail" || row.result === "partial")
    .map((row) => {
      const names = row.evidence.filter((e) => ARTIFACT_NAME.test(e)).slice(0, ARTIFACTS_MAX);
      const text = flat(row.text, TEXT_CAP);
      const body = [`expected: ${text}`, `seen: ${flat(seen, TEXT_CAP)}`, ...(names.length > 0 ? [`artifacts: ${names.join(", ")}`] : []), ...(cause && /^[a-z_]{1,40}$/.test(cause) ? [`cause: ${cause}`] : [])].join("\n");
      return finding(`${row.result === "fail" ? "scenario failed" : "scenario partly done"}: ${flat(row.text, TITLE_CAP)}`, body, row.criterion ? flat(row.criterion, 40) : null);
    });
}

/** What Evidence sends a card back for: the reason and the part that is missing, as one finding. */
export function evidenceFindings(reason: string): Finding[] {
  return [finding("Evidence is missing", flat(reason, TEXT_CAP), null)];
}
