// Finding v2 helpers: a severity level, a stable id, normalisation of today's findings and the merge of
// duplicates. Pure; a finding written before v2.2 goes through `normaliseFinding` and is a v2 finding.
import type { Finding } from "./stage.ts";

export type SeverityLevel = "blocker" | "should_fix" | "nit";

/** The table wave 4 used for calibration: `bug|security|blocker` block, `test|perf|question|should_fix`
 *  should be fixed, anything else is a nit. `severity` stays a free string on the wire. */
export function severityOf(text: string): SeverityLevel {
  const s = text.trim().toLowerCase();
  if (s === "bug" || s === "security" || s === "blocker") return "blocker";
  if (s === "test" || s === "perf" || s === "question" || s === "should_fix") return "should_fix";
  return "nit";
}

const RANK: Record<SeverityLevel, number> = { blocker: 2, should_fix: 1, nit: 0 };

/** A short stable id (`F` and eight hex digits, FNV-1a) from the path, the line and the title. */
export function findingId(f: Pick<Finding, "path" | "line" | "title">): string {
  let h = 0x811c9dc5;
  for (const ch of `${f.path}\n${f.line}\n${f.title}`) {
    h ^= ch.codePointAt(0) ?? 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `F${h.toString(16).padStart(8, "0")}`;
}

/** Fills what a v1 finding lacks: `id`, `suggested_fix` from `suggestion_code`, `description` from `body`.
 *  Values already set win. */
export function normaliseFinding(f: Finding): Finding {
  return {
    ...f,
    id: f.id ?? findingId(f),
    suggested_fix: f.suggested_fix ?? f.suggestion_code ?? null,
    description: f.description ?? f.body,
  };
}

const titleKey = (t: string): string => t.trim().replace(/\s+/g, " ").toLowerCase();

/** One finding per fact: the same id, or the same path within 3 lines with the same normalised title.
 *  The kept finding sits at its first member's place, carries the highest severity and confidence, and
 *  lists the others' ids in `merged`. */
export function mergeDuplicateFindings(findings: readonly Finding[]): Finding[] {
  const out: Finding[] = [];
  for (const f of findings) {
    const id = f.id ?? findingId(f);
    const at = out.findIndex((k) => {
      const kid = k.id ?? findingId(k);
      return kid === id || (k.path === f.path && Math.abs(k.line - f.line) <= 3 && titleKey(k.title) === titleKey(f.title));
    });
    const kept = out[at];
    if (kept === undefined) {
      out.push(f);
      continue;
    }
    const keptId = kept.id ?? findingId(kept);
    const merged = [...(kept.merged ?? [])];
    if (id !== keptId && !merged.includes(id)) merged.push(id);
    out[at] = {
      ...kept,
      severity: RANK[severityOf(f.severity)] > RANK[severityOf(kept.severity)] ? f.severity : kept.severity,
      confidence: Math.max(kept.confidence, f.confidence),
      ...(merged.length > 0 ? { merged } : {}),
    };
  }
  return out;
}
