// The cost ledger (te-spec §4): one record per run, in effective tokens, and what the economy's own model calls cost beside what the work did.
import { type Tokens, effectiveTokens } from "@hardness/contracts";

/** The packs that are the economy's own cost, not the work's. */
export const OVERHEAD_PACKS: readonly string[] = ["loop_judge", "loop_redirect", "fact_propose"];

export interface LedgerRecord {
  at: string;
  runId: string;
  pack: string;
  card: string;
  kind: "exec" | "overhead";
  /** The run's tokens priced as input-token units; 0 when the runtime counted none. */
  effective: number;
  tokens: Tokens | null;
  /** What the run cost in dollars when it is known and no token count is. */
  costUsd?: number;
}

export function ledgerRecord(run: { at: string; runId: string; pack: string; cardId: string; tokens: Tokens | null; costUsd?: number | null }): LedgerRecord {
  return {
    at: run.at,
    runId: run.runId,
    pack: run.pack,
    card: run.cardId,
    kind: OVERHEAD_PACKS.includes(run.pack) ? "overhead" : "exec",
    effective: run.tokens ? effectiveTokens(run.tokens) : 0,
    tokens: run.tokens,
    ...(run.costUsd ? { costUsd: run.costUsd } : {}),
  };
}

/** The totals in effective tokens; `overheadUnpriced` counts the overhead records that carry no tokens (a runtime that reported none), which the totals cannot price. */
export function summary(records: LedgerRecord[]): { exec: number; overhead: number; overheadShare: number; overheadUnpriced: number } {
  let exec = 0;
  let overhead = 0;
  let overheadUnpriced = 0;
  for (const r of records) {
    if (r.kind === "overhead") {
      overhead += r.effective;
      if (r.tokens === null) overheadUnpriced += 1;
    } else exec += r.effective;
  }
  const total = exec + overhead;
  return { exec, overhead, overheadShare: total === 0 ? 0 : overhead / total, overheadUnpriced };
}
