// A repo's signals per pack, read from the machine's own records: the stage runs in Postgres (runs, escalated outcomes,
// cost), the economy's guard log (the loop guard's stops, which end a run with `LOOP_STUCK`) and its ledger (cost of the
// runs that are no stage run, such as the guard's own judge). A stage run counts for the pack its task state runs.
import type { PackId } from "@hardness/contracts";
import type { DataSource } from "typeorm";

import type { EconomyStore } from "../../application/economy.ts";
import type { RepoSignals } from "../../application/repo-signals.ts";
import type { RepoSignal } from "../../domain/config-proposal.ts";
import { packForState } from "../../domain/packs.ts";

type StageRow = { stage: string; runs: string; escalations: string; cost: string | null };

export function pgRepoSignals(db: DataSource, economy: EconomyStore): RepoSignals {
  return {
    async forRepo(repo, since) {
      const out: Partial<Record<PackId, RepoSignal>> = {};
      const of = (pack: PackId): RepoSignal => (out[pack] ??= { runs: 0, escalations: 0, stuck: 0, costUsd: 0 });
      const rows: StageRow[] = await db.query(
        `select r.stage, count(*) as runs, count(*) filter (where r.outcome = 'escalated') as escalations, sum(r.cost_usd) as cost
           from stage_runs r join tasks t on t.id = r.task_id
          where t.repo_path = $1 and r.started_at >= $2
          group by r.stage`,
        [repo, since],
      );
      for (const row of rows) {
        const pack = packForState(row.stage as never);
        if (!pack) continue;
        const signal = of(pack);
        signal.runs += Number(row.runs);
        signal.escalations += Number(row.escalations);
        signal.costUsd += Number(row.cost ?? 0);
      }
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
