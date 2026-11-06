// Factory metrics: how the pipeline is doing over a window. Rows come from Postgres and
// the numbers are computed here, so a window with no data gives null, never NaN.
import { type EngineId, type EngineMetrics, type FingerprintMetrics, type FlowMetrics, type Metrics, type MetricsGroupBy, RUNNING, type RepoMetrics, type Slots, type TaskState, WAITING_ON_USER, RUN_OR_GATE, waitsOnPerson, isTerminal } from "@hardness/contracts";
import type { DataSource } from "typeorm";

import { namesOf } from "../../domain/card-events.ts";
import { ratio, stats } from "../http/metrics.ts";

export interface MetricsOptions {
  since: Date;
  until?: Date;
  slots: Slots;
  /** The spend ceilings, when set, and the trailing-24h spend they apply to. */
  budget?: { taskUsd: number | null; dailyUsd: number | null; spentTodayUsd: number };
  /** Only this repo's tasks (null: only tasks with no repo); absent means every task. */
  repo?: string | null;
  /** Adds one slim row per value to the answer: per repo (`byRepo`), per engine (`byEngine`), per fingerprint (`byFingerprint`). */
  groupBy?: MetricsGroupBy;
  /** The gate SLA a wait is judged by, in seconds (the machine's default; a repo's own is approximated by it). */
  gateSlaSecs?: number | null;
}

/** The window's numbers for one repo, slimmed to what a per-repo table shows. */
function slim(repo: string | null, m: Metrics): RepoMetrics {
  return {
    repo,
    tasks: m.tasks,
    escalationRate: m.escalations.rate,
    firstPassVerifying: m.firstPassRate.verifying,
    costUsd: m.cost.totalUsd,
  };
}

type RunRow = { task_id: string; stage: string; attempt: number; status: string; outcome: string | null; turns: number | null; cost: string | null; ms: string | null; engine: EngineId | null; fingerprint: string | null };

/** The window's stage runs per fingerprint: runs from before fingerprints (null) last, then the
 *  most runs first. */
export function byFingerprint(runs: RunRow[]): FingerprintMetrics[] {
  const groups = new Map<string | null, RunRow[]>();
  for (const r of runs) groups.set(r.fingerprint, [...(groups.get(r.fingerprint) ?? []), r]);
  const sorted = (values: (string | null)[]) => [...new Set(values.filter((v): v is string => v !== null))].sort();
  return [...groups]
    .map(([fingerprint, rows]): FingerprintMetrics => {
      const finished = rows.filter((r) => r.status === "passed" || r.status === "failed");
      return {
        fingerprint,
        runs: rows.length,
        passRate: ratio(finished.filter((r) => r.status === "passed").length, finished.length),
        costUsd: rows.reduce((sum, r) => sum + (r.cost === null ? 0 : Number(r.cost)), 0),
        durationMs: stats(finished.filter((r) => r.ms !== null).map((r) => Number(r.ms))),
        stages: sorted(rows.map((r) => r.stage)),
        engines: sorted(rows.map((r) => r.engine)),
      };
    })
    .sort((a, b) => (a.fingerprint === null ? 1 : b.fingerprint === null ? -1 : b.runs - a.runs || a.fingerprint.localeCompare(b.fingerprint)));
}

const FIRST_PASS_STAGES = ["verifying", "ci_watch", "implementing"] as const;

const mean = (values: number[]): number | null => (values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length);

/** The window's stage runs as one row per engine, named engines in order and then null. */
function engineRows(
  runs: Array<{ attempt: number; status: string; outcome: string | null; engine: EngineId | null; turns: number | null; cost: string | null; ms: string | null }>,
  escalatedOn: Array<EngineId | null>,
): EngineMetrics[] {
  const engines = [...new Set(runs.map((r) => r.engine))].sort((a, b) => (a === null ? 1 : b === null ? -1 : a.localeCompare(b)));
  return engines.map((engine) => {
    const mine = runs.filter((r) => r.engine === engine);
    const finished = mine.filter((r) => r.status === "passed" || r.status === "failed");
    const firsts = finished.filter((r) => r.attempt === 1);
    const turns = finished.flatMap((r) => (r.turns === null ? [] : [r.turns]));
    const ms = finished.flatMap((r) => (r.ms === null ? [] : [Number(r.ms)]));
    return {
      engine,
      stageRuns: mine.length,
      firstPassRate: ratio(firsts.filter((r) => r.status === "passed").length, firsts.length),
      escalations: escalatedOn.filter((on) => on === engine).length,
      rateLimited: mine.filter((r) => r.outcome === "rate_limited").length,
      meanTurns: mean(turns),
      meanDurationMs: mean(ms),
      costUsd: mine.reduce((sum, r) => sum + (r.cost === null ? 0 : Number(r.cost)), 0),
    };
  });
}
const DEFAULT_GATE_SLA_SECS = 3600;

/** Every gate answered in the window: the wait from entering a waiting state to leaving it, by gate. */
export function gateWaits(
  transitions: Array<{ task_id: string; from: string | null; to: string | null; at: Date; gate?: string | null }>,
  window: [Date, Date],
): Array<{ state: string; ms: number }> {
  const open = new Map<string, { state: string; at: Date }>();
  const waits: Array<{ state: string; ms: number }> = [];
  for (const t of [...transitions].sort((a, b) => a.at.getTime() - b.at.getTime())) {
    const waiting = open.get(t.task_id);
    if (waiting && t.from === waiting.state) {
      open.delete(t.task_id);
      if (t.at >= window[0] && t.at <= window[1] && (t.to !== waiting.state || RUN_OR_GATE.has(waiting.state as never))) waits.push({ state: waiting.state, ms: t.at.getTime() - waiting.at.getTime() });
    }
    // A state that holds a stage or a gate is a wait only for a step that opened a gate.
    const isWait = t.to && (RUN_OR_GATE.has(t.to as never) ? t.gate === "true" : WAITING_ON_USER.has(t.to as never) && t.to !== t.from);
    if (t.to && isWait) open.set(t.task_id, { state: t.to, at: t.at });
  }
  return waits;
}

const NOT_RECORDED = "nothing records a failed change yet";
const DAY = 86_400_000;

/** One logged event, slimmed to what `namesOf` and the flow numbers read. */
export interface FlowRow {
  task_id: string;
  kind: string;
  payload: Record<string, unknown>;
  at: Date;
}

/** The diagram's flow numbers from the window's event log, through `namesOf`. Each cohort is the tasks whose ending event falls in the window. */
export function flowMetrics(rows: FlowRow[], window: [Date, Date]): FlowMetrics {
  const [since, until] = window;
  const inWindow = (at: Date) => at.getTime() >= since.getTime() && at.getTime() <= until.getTime();
  const named = rows.map((r) => ({ ...r, names: namesOf(r), at: new Date(r.at) })).sort((a, b) => a.at.getTime() - b.at.getTime());
  const byTask = new Map<string, typeof named>();
  for (const r of named) {
    const mine = byTask.get(r.task_id);
    if (mine) mine.push(r);
    else byTask.set(r.task_id, [r]);
  }
  const first = (rs: typeof named, name: string) => rs.find((r) => (r.names as string[]).includes(name));
  const last = (rs: typeof named, name: string) => rs.findLast((r) => (r.names as string[]).includes(name));
  const count = (values: number[]) => ({ value: mean(values), n: values.length });
  const withN = (values: number[]) => ({ ...stats(values), n: values.length });

  const planCycle: number[] = [];
  const rounds: number[] = [];
  const buildRuns: number[] = [];
  const lead: number[] = [];
  let merges = 0;
  for (const rs of byTask.values()) {
    const triaged = first(rs, "card.triaged");
    const approved = first(rs, "card.approved");
    if (triaged && approved && approved.at >= triaged.at && inWindow(approved.at)) planCycle.push(approved.at.getTime() - triaged.at.getTime());
    const planned = last(rs, "card.planned");
    const designed = Number(((planned?.payload.detail as { rounds?: { tests?: unknown } } | undefined)?.rounds ?? {}).tests);
    if (planned && inWindow(planned.at) && Number.isFinite(designed)) rounds.push(designed);
    const done = last(rs, "build.done");
    if (done && inWindow(done.at)) buildRuns.push(rs.filter((r) => (r.names as string[]).includes("build.started")).length);
    const merged = first(rs, "ship.merged");
    const created = first(rs, "card.created");
    if (merged && inWindow(merged.at)) {
      merges += 1;
      if (created) lead.push(merged.at.getTime() - created.at.getTime());
    }
  }
  const weeks = (until.getTime() - since.getTime()) / (7 * DAY);
  return {
    planCycleMs: withN(planCycle),
    coverageRounds: count(rounds),
    buildRuns: count(buildRuns),
    leadTimeMs: withN(lead),
    mergesPerWeek: { value: weeks > 0 ? merges / weeks : null, n: merges },
    changeFailureRate: { value: null, n: 0, reason: NOT_RECORDED },
    timeToRestoreMs: { value: null, n: 0, reason: NOT_RECORDED },
  };
}

export async function computeMetrics(db: DataSource, options: MetricsOptions): Promise<Metrics> {
  const { since, slots } = options;
  const until = options.until ?? new Date();
  const window = [since, until];
  // Every query takes a third parameter, the repo: a path matches that repo's tasks, "" the
  // tasks with none, and null every task. `t` is the tasks row the predicate reads.
  const byRepo = "repo" in options;
  const scope = byRepo ? (options.repo === null ? "" : options.repo!) : null;
  const params = [...window, scope];
  const inScope = "($3::text is null or ($3 = '' and t.repo_path is null) or t.repo_path = $3)";

  const taskRows: { state: string; queued: boolean; created: boolean; repo_path: string | null; gate_open: boolean }[] = await db.query(
    `select state, queued, (created_at >= $1 and created_at <= $2) as created, repo_path,
            exists (select 1 from approvals a where a.task_id = t.id and a.decision is null) as gate_open
       from tasks t where ${inScope}`,
    params,
  );
  const closedRows: { ms: string }[] = await db.query(
    `select extract(epoch from (e.at - t.created_at)) * 1000 as ms
       from events e join tasks t on t.id = e.task_id
      where e.kind = 'transition' and e.payload->>'to' = 'closed' and e.at >= $1 and e.at <= $2 and ${inScope}`,
    params,
  );
  const runs: RunRow[] =
    await db.query(
      `select r.task_id, r.stage, r.attempt, r.status, r.outcome, r.turns, r.cost_usd as cost, r.engine, r.fingerprint,
              extract(epoch from (r.ended_at - r.started_at)) * 1000 as ms
         from stage_runs r join tasks t on t.id = r.task_id
        where r.started_at >= $1 and r.started_at <= $2 and ${inScope}`,
      params,
    );
  const escalations: { task_id: string; reason: string | null }[] = await db.query(
    `select e.task_id, e.payload->>'reason' as reason from events e join tasks t on t.id = e.task_id
      where e.kind = 'transition' and e.payload->>'to' = 'escalated' and e.at >= $1 and e.at <= $2 and ${inScope}`,
    params,
  );
  const transitions: { task_id: string; from: string | null; to: string | null; at: Date; gate: string | null }[] = await db.query(
    `select e.task_id, e.payload->>'from' as "from", e.payload->>'to' as "to", e.payload->>'gate' as gate, e.at
       from events e join tasks t on t.id = e.task_id
      where e.kind = 'transition' and $1::timestamptz is not null and e.at <= $2 and ${inScope}
      order by e.at`,
    params,
  );
  // The events `namesOf` reads, slimmed in SQL: only the fields it and the flow numbers look at, never a stage's whole detail.
  const flowRows: FlowRow[] = await db.query(
    `select e.task_id, e.kind, e.at,
            jsonb_strip_nulls(jsonb_build_object('stage', e.payload->'stage', 'status', e.payload->'status', 'event', e.payload->'event', 'from', e.payload->'from', 'to', e.payload->'to',
              'escalation', e.payload->'escalation', 'archiveReason', e.payload->'archiveReason',
              'detail', case when e.kind = 'stage.finished' then jsonb_strip_nulls(jsonb_build_object('rounds', e.payload #> '{detail,rounds}', 'cases', case when e.payload #> '{detail,cases}' is not null then '[]'::jsonb end)) end)) as payload
       from events e join tasks t on t.id = e.task_id
      where e.kind in ('task.created', 'task.shipped', 'ship.merged', 'task.closed', 'transition', 'stage.started', 'stage.finished', 'stage.slice.committed', 'stage.pr.opened') and e.at <= $2 and $1::timestamptz is not null and ${inScope}
        -- only tasks with an ending event inside the window: the numbers never need the history of the rest
        and e.task_id in (select w.task_id from events w
                           where w.at >= $1 and w.at <= $2
                             and (w.kind in ('task.shipped', 'ship.merged')
                               or (w.kind = 'transition' and w.payload->>'event' = 'approved' and w.payload->>'from' = 'awaiting_approval')
                               or (w.kind = 'stage.finished' and w.payload->>'status' = 'passed' and w.payload->>'stage' in ('test_design', 'implementing'))))`,
    params,
  );
  const touched: { retries: { verify: number; e2e: number; ci: number; total: number } }[] = await db.query(
    `select retries from tasks t where ${inScope}
        and id in (select task_id from stage_runs where started_at >= $1 and started_at <= $2)`,
    params,
  );

  // Tasks.
  const states = taskRows as unknown as { state: never; queued: boolean; gate_open: boolean }[];
  const open = states.filter((t) => !isTerminal(t.state as TaskState));
  const tasks = {
    created: taskRows.filter((t) => t.created).length,
    closed: closedRows.length,
    open: open.length,
    // A state that holds a stage or a gate counts by whether an approval is open.
    waitingOnYou: open.filter((t) => waitsOnPerson(t.state as TaskState, t.gate_open)).length,
    running: open.filter((t) => (RUNNING.has(t.state) || (RUN_OR_GATE.has(t.state) && !t.gate_open)) && !t.queued).length,
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

  // Gates: how long each one waited on you, and how many were answered inside the SLA.
  const waits = gateWaits(transitions.map((t) => ({ ...t, at: new Date(t.at) })), [since, until]);
  const gateSla = options.gateSlaSecs === undefined ? DEFAULT_GATE_SLA_SECS : options.gateSlaSecs;
  const byGate = new Map<string, number[]>();
  for (const w of waits) byGate.set(w.state, [...(byGate.get(w.state) ?? []), w.ms]);
  const gates: Metrics["gates"] = {
    answered: waits.length,
    withinSla: gateSla === null ? null : ratio(waits.filter((w) => w.ms <= gateSla * 1000).length, waits.length),
    waitMs: Object.fromEntries([...byGate].map(([state, ms]) => [state, stats(ms)])),
  };

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

  // The rows `groupBy` asks for, under their own key.
  let grouped: Pick<Metrics, "byRepo" | "byEngine" | "byFingerprint"> = {};
  switch (options.groupBy) {
    case "repo": {
      // One slim row per repo: the same numbers, computed per repo, named repos first then "none".
      const repos = [...new Set(taskRows.map((t) => t.repo_path))].sort((a, b) =>
        a === null ? 1 : b === null ? -1 : a.localeCompare(b),
      );
      const byRepo: RepoMetrics[] = [];
      for (const repo of repos) {
        const { groupBy: _ignored, ...rest } = options;
        byRepo.push(slim(repo, await computeMetrics(db, { ...rest, until, repo })));
      }
      grouped = { byRepo };
      break;
    }
    case "engine": {
      // One row per engine the window's stage runs started on; an escalation counts against the
      // engine of the task's latest run before it.
      const escalatedOn: { engine: EngineId | null }[] = await db.query(
        `select (select r.engine from stage_runs r where r.task_id = e.task_id and r.started_at <= e.at order by r.started_at desc limit 1) as engine
           from events e join tasks t on t.id = e.task_id
          where e.kind = 'transition' and e.payload->>'to' = 'escalated' and e.at >= $1 and e.at <= $2 and ${inScope}`,
        params,
      );
      grouped = { byEngine: engineRows(runs, escalatedOn.map((row) => row.engine)) };
      break;
    }
    case "fingerprint":
      grouped = { byFingerprint: byFingerprint(runs) };
      break;
  }


  return {
    since: since.toISOString(),
    until: until.toISOString(),
    ...(byRepo ? { repo: options.repo ?? null } : {}),
    ...grouped,
    tasks,
    cycleTimeMs: { task: stats(closedRows.map((r) => Number(r.ms))), perStage },
    gates,
    flow: flowMetrics(flowRows, [since, until]),
    firstPassRate,
    escalations: { rate: ratio(escalatedTasks.size, started.size), topReasons },
    retries: { perTask: stats(touched.map((t) => t.retries.total)), byLoop },
    cost: {
      totalUsd: [...costByTask.values()].reduce((a, b) => a + b, 0),
      perTaskUsd: stats([...costByTask.values()]),
      byStage: costByStage,
    },
    queue: { depth: tasks.queued, slots, utilisation: ratio(slots.active, slots.max) },
    budget: {
      taskUsd: options.budget?.taskUsd ?? null,
      dailyUsd: options.budget?.dailyUsd ?? null,
      spentTodayUsd: options.budget?.spentTodayUsd ?? 0,
      remainingTodayUsd:
        options.budget?.dailyUsd == null ? null : Math.max(0, options.budget.dailyUsd - options.budget.spentTodayUsd),
    },
  };
}
