// Facts a stage run knows that had no row of their own, as the rows the diagram names (`ci.status`,
// `verify.findings`, `evidence.media_ready`, `card.fast_lane`). Pure: the pipeline logs them beside
// `stage.finished`. Payloads hold counts and enum values only, never text a model or a reviewer wrote.
import { type Finding, severityOf } from "@hardness/contracts";

import { failedChecks } from "./stages/ci.ts";
import type { StageResult } from "./ports.ts";

export interface FactRow {
  kind: string;
  payload: Record<string, unknown>;
}

export function stageFactRows(stage: string, status: string, result: Pick<StageResult, "detail" | "findings">): FactRow[] {
  const ran = status === "passed" || status === "failed";
  const detail = result.detail ?? {};
  const rows: FactRow[] = [];
  if (stage === "verifying" && ran) {
    const found = (result.findings ?? (Array.isArray(detail.findings) ? (detail.findings as Finding[]) : [])).map((f) => severityOf(String(f?.severity ?? "")));
    rows.push({ kind: "verify.findings", payload: { count: found.length, blockers: found.filter((s) => s === "blocker").length, shouldFix: found.filter((s) => s === "should_fix").length, nits: found.filter((s) => s === "nit").length } });
  }
  if (stage === "ci_watch" && ran && Array.isArray(detail.checks)) {
    const checks = detail.checks as Array<{ name?: string; state?: string }>;
    const failed = failedChecks(checks as never).length;
    rows.push({ kind: "ci.status", payload: { state: failed > 0 ? "red" : "green", total: checks.length, failed, ...(typeof detail.class === "string" && /^[a-z_]{1,20}$/.test(detail.class) ? { class: detail.class } : {}) } });
  }
  if (stage === "evidence" && status === "passed" && typeof detail.artifactCount === "number" && detail.artifactCount > 0) {
    rows.push({ kind: "evidence.media_ready", payload: { count: detail.artifactCount } });
  }
  if (stage === "triage" && status === "passed" && detail.outcome === "fast_lane") rows.push({ kind: "card.fast_lane", payload: {} });
  return rows;
}
