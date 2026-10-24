// Factory metrics: how the pipeline is doing over a window. Rows come from Postgres and
// the numbers are computed here, so a window with no data gives null, never NaN.
import { type Metrics, RUNNING, WAITING_ON_USER } from "@hardness/contracts";
import type { DataSource } from "typeorm";

import { ratio, stats } from "../http/metrics.ts";

export interface MetricsOptions {
  since: Date;
  until?: Date;
  slots: { max: number; active: number };
}

const FIRST_PASS_STAGES = ["verifying", "ci_watch", "implementing"] as const;

export async function computeMetrics(db: DataSource, options: MetricsOptions): Promise<Metrics> {
  const { since, slots } = options;
  const until = options.until ?? new Date();
  const window = [since, until];

  const taskRows: { state: string; queued: boolean; created: boolean }[] = await db.query(
    "select state, queued, (created_at >= $1 and created_at <= $2) as created from tasks",
    window,
  );
  const closedRows: { ms: string }[] = await db.query(
    `select extract(epoch from (e.at - t.created_at)) * 1000 as ms
       from events e join tasks t on t.id = e.task_id
      where e.kind = 'transition' and e.payload->>'to' = 'closed' and e.at >= $1 and e.at <= $2`,
    window,
  );
  const runs: { task_id: string; stage: string; attempt: number; status: string; cost: string | null; ms: string | null }[] =
    await db.query(
      `select task_id, stage, attempt, status, cost_usd as cost,
              extract(epoch from (ended_at - started_at)) * 1000 as ms
         from stage_runs where started_at >= $1 and started_at <= $2`,
      window,
    );
  const escalations: { task_id: string; reason: string | null }[] = await db.query(
    `select task_id, payload->>'reason' as reason from events
      where kind = 'transition' and payload->>'to' = 'escalated' and at >= $1 and at <= $2`,
    window,
  );
  const touched: { retries: { verify: number; e2e: number; ci: number; total: number } }[] = await db.query(
    "select retries from tasks where id in (select task_id from stage_runs where started_at >= $1 and started_at <= $2)",
    window,
  );

  // Tasks.
  const states = taskRows as unknown as { state: never; queued: boolean }[];
  const open = states.filter((t) => (t.state as string) !== "closed");
  const tasks = {
    created: taskRows.filter((t) => t.created).length,
    closed: closedRows.length,
    open: open.length,
    waitingOnYou: open.filter((t) => WAITING_ON_USER.has(t.state)).length,
    running: open.filter((t) => RUNNING.has(t.state) && !t.queued).length,
    queued: open.filter((t) => t.queued).length,
  };

  // Stage durations.
  const finished = runs.filter((r) => (r.status === "passed" || r.status === "failed") && r.ms !== null);
  const byStage = new Map<string, number[]>();
  for (const r of finished) byStage.set(r.stage, [...(byStage.get(r.stage) ?? []), Number(r.ms)]);
  const perStage = Object.fromEntries(
    [...byStage].map(([stage, ms]) => [stage, { ...stats(ms), runs: ms.length }]),
  );

  // First pass: the first attempt of each stage per task.
  const firstPassRate = Object.fromEntries(
    FIRST_PASS_STAGES.map((stage) => {
      const firsts = runs.filter((r) => r.stage === stage && r.attempt === 1 && (r.status === "passed" || r.status === "failed"));
      return [stage, ratio(firsts.filter((r) => r.status === "passed").length, firsts.length)];
    }),
  ) as Metrics["firstPassRate"];

  // Escalations.
  const started = new Set(runs.map((r) => r.task_id));
  const escalatedTasks = new Set(escalations.map((e) => e.task_id));
  const reasons = new Map<string, number>();
  for (const e of escalations) if (e.reason) reasons.set(e.reason, (reasons.get(e.reason) ?? 0) + 1);
  const topReasons = [...reasons]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason))
    .slice(0, 5);

  // Retries.
  const byLoop = { verify: 0, e2e: 0, ci: 0 };
  for (const t of touched) {
    byLoop.verify += t.retries.verify;
    byLoop.e2e += t.retries.e2e;
    byLoop.ci += t.retries.ci;
  }

  // Cost.
  const costByStage: Record<string, number> = {};
  const costByTask = new Map<string, number>();
  for (const r of runs) {
    if (r.cost === null) continue;
    costByStage[r.stage] = (costByStage[r.stage] ?? 0) + Number(r.cost);
    costByTask.set(r.task_id, (costByTask.get(r.task_id) ?? 0) + Number(r.cost));
  }

  return {
    since: since.toISOString(),
    until: until.toISOString(),
    tasks,
    cycleTimeMs: { task: stats(closedRows.map((r) => Number(r.ms))), perStage },
    firstPassRate,
    escalations: { rate: ratio(escalatedTasks.size, started.size), topReasons },
    retries: { perTask: stats(touched.map((t) => t.retries.total)), byLoop },
    cost: {
      totalUsd: [...costByTask.values()].reduce((a, b) => a + b, 0),
      perTaskUsd: stats([...costByTask.values()]),
      byStage: costByStage,
    },
    queue: { depth: tasks.queued, slots, utilisation: ratio(slots.active, slots.max) },
  };
}
