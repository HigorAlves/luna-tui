// A repo's signals per pack, read from the machine's own records: the stage runs in Postgres (runs, cost), the task event
// log (every `stage_done escalated` transition), the economy's guard log (the loop guard's stops) and its ledger (cost of
// the runs that are no stage run, such as the guard's own judge). A stage run counts for a pack only when its task state
// runs exactly one agent pack; a shared state (test_design, implementing, ...) gives no signal, so no proposal follows from mixed runs.
import type { EngineId, PackId } from "@hardness/contracts";
import type { DataSource } from "typeorm";

import type { EconomyStore } from "../../application/economy.ts";
import type { RepoSignals } from "../../application/repo-signals.ts";
import type { RepoSignal } from "../../domain/config-proposal.ts";
import { soleAgentPackForState } from "../../domain/packs.ts";

type StageRow = { stage: string; engine: string | null; runs: string; cost: string | null };
type EscalationRow = { stage: string; escalations: string };

export function pgRepoSignals(db: DataSource, economy: EconomyStore): RepoSignals {
  return {
    async forRepo(repo, since) {
      const out: Partial<Record<PackId, RepoSignal>> = {};
      const of = (pack: PackId): RepoSignal => (out[pack] ??= { runs: 0, escalations: 0, stuck: 0, costUsd: 0 });
      const rows: StageRow[] = await db.query(
        `select r.stage, r.engine, count(*) as runs, sum(r.cost_usd) as cost
           from stage_runs r join tasks t on t.id = r.task_id
          where t.repo_path = $1 and r.started_at >= $2
          group by r.stage, r.engine`,
        [repo, since],
      );
      for (const row of rows) {
        const pack = soleAgentPackForState(row.stage as never);
        if (!pack) continue;
        const signal = of(pack);
        signal.runs += Number(row.runs);
        signal.costUsd += Number(row.cost ?? 0);
        // The engine each run recorded: the rule trusts what ran, not what luna.yaml or the pack default says.
        if (row.engine) {
          const engine = row.engine as EngineId;
          signal.engines = { ...signal.engines, [engine]: (signal.engines?.[engine] ?? 0) + Number(row.runs) };
        }
      }
      // A stage run keeps its own outcome: a loop-guard stop, a stuck-detector stop and a second scope red are all stored as
      // `fail`. The pipeline event is what escalates them, so escalations are counted from the event log, per state it left.
      const escalated: EscalationRow[] = await db.query(
        `select e.payload->>'from' as stage, count(*) as escalations
           from events e join tasks t on t.id = e.task_id
          where t.repo_path = $1 and e.at >= $2 and e.kind = 'transition' and e.payload->>'event' = 'stage_done' and e.payload->>'to' = 'escalated'
          group by 1`,
        [repo, since],
      );
      for (const row of escalated) {
        const pack = soleAgentPackForState(row.stage as never);
        if (pack) of(pack).escalations += Number(row.escalations);
      }
      // Evidence only: every loop-guard stop is already among the escalations above.
      const from = since.getTime();
      for (const event of await economy.guard(repo)) {
        if (event.action === "stop" && Date.parse(event.at) >= from) of(event.pack as PackId).stuck += 1;
      }
      // Only the economy's own runs: a stage run's ledger record repeats the cost stage_runs already holds.
      for (const record of await economy.ledger(repo)) {
        if (record.kind === "overhead" && record.costUsd && Date.parse(record.at) >= from) of(record.pack as PackId).costUsd += record.costUsd;
      }
      return out;
    },
  };
}
