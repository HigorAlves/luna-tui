// Severity recalibration of a review's findings, both ways, before the verdict is computed: finding_classify reads each
// finding against the code, and only an answer at the pack's proceed bar moves a severity.
//   blocker -> `bug`, for a finding the reviewer called a suggestion, a question or a nit;
//   nit -> `suggestion`, for a bug, a test or an api-surface finding;
//   should_fix leaves the severity as it is.
// A security finding is never raised (it is already the gravest) and is lowered only on a very confident nit.
import { type Finding, findingId } from "@hardness/contracts";

import { type ClassifyDeps, classifyFindings } from "./classify-findings.ts";

/** What a security finding's nit answer must reach before the severity drops: above the pack's proceed bar. */
export const SECURITY_LOWER_BAR = 0.9;

export interface Recalibrated {
  id: string;
  from: string;
  to: string;
}

const LOW = new Set(["suggestion", "question", "nit"]);
const HIGH = new Set(["bug", "test", "api-surface"]);

function targetOf(severity: string, classified: "blocker" | "should_fix" | "nit", confidence: number | null): string | null {
  if (classified === "blocker" && LOW.has(severity)) return "bug";
  if (classified === "nit" && HIGH.has(severity)) return "suggestion";
  if (classified === "nit" && severity === "security" && (confidence ?? 0) >= SECURITY_LOWER_BAR) return "suggestion";
  return null;
}

export async function recalibrateSeverity(deps: ClassifyDeps, findings: Finding[]): Promise<{ findings: Finding[]; changes: Recalibrated[] }> {
  if (!deps.decide || findings.length === 0) return { findings, changes: [] };
  const withIds = findings.map((f) => ({ ...f, id: f.id ?? findingId(f) }));
  const safe: ClassifyDeps = { ...deps, excerpt: (f) => deps.excerpt(f).catch(() => "") };
  const { classified } = await classifyFindings(safe, withIds);
  const rows = new Map(classified.map((r) => [r.id, r]));
  const changes: Recalibrated[] = [];
  const out = withIds.map((f) => {
    const row = rows.get(f.id!);
    if (!row || row.verdict !== "proceed" || row.classified === null) return f;
    const to = targetOf(f.severity, row.classified, row.confidence);
    if (to === null) return f;
    changes.push({ id: f.id!, from: f.severity, to });
    return { ...f, severity: to };
  });
  return { findings: out, changes };
}
