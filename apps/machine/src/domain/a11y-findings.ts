// The audit's findings as review findings (RFC 0013, "The level"): WCAG 2.2 AA by default, axe critical/serious and judged failures block,
// moderate/minor should be fixed, a criterion above the repo's level is a nit, and `advisory` blocks nothing. The level of a criterion is WCAG's,
// never the auditor's word. axe's impact words are never passed through as severities: `severityOf` would read `serious` as should_fix. Pure.
import { type A11yFinding, type Finding, WCAG_LEVEL_OF, findingId, normaliseFinding } from "@hardness/contracts";

const RANK = { A: 1, AA: 2, AAA: 3 } as const;

export function a11yFindings(found: readonly A11yFinding[], config: { level: "AA" | "AAA"; mode: "gate" | "advisory" }): { findings: Finding[]; notes: string[] } {
  const notes: string[] = [];
  const findings = found.map((f) => {
    const level = WCAG_LEVEL_OF[f.criterion];
    let severity: "blocker" | "should_fix" | "nit";
    if (!level) {
      notes.push(`${f.criterion} is not a WCAG 2.2 success criterion: kept as should_fix`);
      severity = "should_fix";
    } else if (RANK[level] > RANK[config.level]) severity = "nit";
    else if (config.mode === "advisory") severity = "should_fix";
    else if (f.source === "judged") severity = "blocker";
    else severity = f.impact === "critical" || f.impact === "serious" ? "blocker" : "should_fix";
    const base = {
      path: f.page,
      line: 0,
      severity,
      title: `WCAG ${f.criterion} (${level ?? "?"}): ${f.selector} on ${f.page}`,
      body: `${f.summary} (state ${f.state}${f.rule ? `, axe ${f.rule}` : ", judged"}${f.evidence.length ? `; evidence ${f.evidence.join(", ")}` : ""})`,
      confidence: f.confidence,
      category: "accessibility" as const,
      criterion_ref: null,
      suggested_fix: f.fix,
    };
    return normaliseFinding({ ...base, id: findingId(base) });
  });
  return { findings, notes };
}
