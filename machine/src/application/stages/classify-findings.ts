// finding_classify over a stage's most severe findings: recorded beside the stage's own severities, never a verdict.
// Verify's review and the e2e stage's design findings share it.
import { type DecisionOverrides, type Finding, severityOf } from "@hardness/contracts";

import { type Decide, judgeCheck } from "./check-decide.ts";

/** How many findings finding_classify sees, the most severe first. */
export const CLASSIFY_MAX = 20;
const LEVEL_RANK = { blocker: 2, should_fix: 1, nit: 0 } as const;

export interface ClassifiedRow {
  id: string;
  title: string;
  path: string;
  line: number;
  severity: string;
  classified: "blocker" | "should_fix" | "nit" | null;
  confidence: number | null;
  verdict: string;
  recordId?: string;
}

export interface ClassifyDeps {
  decide: Decide | null;
  repoPath: string | null;
  decisions: Record<string, DecisionOverrides>;
  /** The code (or the frame and element) around a finding, as the classifier is shown it. */
  excerpt: (finding: Finding) => Promise<string>;
}

export async function classifyFindings(deps: ClassifyDeps, findings: Finding[]): Promise<{ classified: ClassifiedRow[]; calibration: { agree: number; disagree: number; skipped: number } }> {
  const calibration = { agree: 0, disagree: 0, skipped: 0 };
  if (!deps.decide || findings.length === 0) return { classified: [], calibration };
  const decide = deps.decide;
  const top = [...findings].sort((a, b) => LEVEL_RANK[severityOf(b.severity)] - LEVEL_RANK[severityOf(a.severity)] || b.confidence - a.confidence).slice(0, CLASSIFY_MAX);
  const classified = await Promise.all(
    top.map(async (finding): Promise<ClassifiedRow> => {
      const excerpt = await deps.excerpt(finding);
      const { verdict, answer, recordId } = await judgeCheck(decide, "finding_classify", { kind: "finding", finding, excerpt }, deps.repoPath, deps.decisions);
      const severity = (answer?.severity ?? null) as { choice?: unknown; confidence?: unknown } | null;
      const usable = (verdict === "proceed" || verdict === "flag") && typeof severity?.choice === "string";
      return {
        id: finding.id ?? "",
        title: finding.title,
        path: finding.path,
        line: finding.line,
        severity: finding.severity,
        classified: usable ? (severity!.choice as "blocker" | "should_fix" | "nit") : null,
        confidence: typeof severity?.confidence === "number" ? severity.confidence : null,
        verdict,
        ...(recordId ? { recordId } : {}),
      };
    }),
  );
  for (const row of classified) {
    if (row.classified === null) calibration.skipped++;
    else if (row.classified === severityOf(row.severity)) calibration.agree++;
    else calibration.disagree++;
  }
  return { classified, calibration };
}
