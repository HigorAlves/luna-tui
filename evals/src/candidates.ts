// The scorecards as the candidates `POST /repos/proposals` takes: an agent pack's baselines (pass rate) and a decision pack's
// scorecard in `decision-defaults.json` (acted-on accuracy). A row with no cost is left out: the machine cannot compare it.
import { EngineId, PackId, type ProposalCandidate } from "@hardness/contracts";

import type { AgentRow } from "./scorecard.ts";

/** The part of a `decision-defaults.json` entry this reads. */
export interface DefaultsEntry {
  measuredAt?: string;
  scorecard?: Record<string, unknown>;
}

export function proposalCandidates(agentRows: AgentRow[], defaults: Record<string, DefaultsEntry>): Partial<Record<PackId, ProposalCandidate[]>> {
  const out: Partial<Record<PackId, ProposalCandidate[]>> = {};
  const add = (pack: PackId, candidate: ProposalCandidate) => (out[pack] = [...(out[pack] ?? []), candidate]);
  for (const r of agentRows) {
    if (r.costPerCase === null) continue;
    add(r.pack, { engine: r.engine, effort: r.effort, n: r.n, quality: r.passRate, costPerCase: r.costPerCase, at: r.at, ...(r.model !== undefined && { model: r.model }) });
  }
  for (const [name, entry] of Object.entries(defaults)) {
    const pack = PackId.safeParse(name).data;
    if (!pack || !entry.measuredAt) continue;
    for (const [engineName, raw] of Object.entries(entry.scorecard ?? {})) {
      const engine = EngineId.safeParse(engineName).data;
      const card = raw as { n?: unknown; actedOnAccuracy?: unknown; costPerCase?: unknown } | null;
      if (!engine || typeof card?.n !== "number" || typeof card.actedOnAccuracy !== "number" || typeof card.costPerCase !== "number") continue;
      add(pack, { engine, effort: null, n: card.n, quality: card.actedOnAccuracy, costPerCase: card.costPerCase, at: entry.measuredAt });
    }
  }
  return out;
}
