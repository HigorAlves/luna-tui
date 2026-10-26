// Entry point for `pnpm dev`: migrates the database, recovers tasks a previous run left
// mid-stage, then serves the API on localhost.
import { serve } from "@hono/node-server";

import { createApp } from "./adapters/http/app.ts";
import { Bus } from "./adapters/http/bus.ts";
import { StreamWatcher } from "./adapters/http/watch.ts";
import { parseSince } from "./adapters/http/metrics.ts";
import { toEvent, toTask } from "./adapters/http/serialize.ts";
import { buildRealStages, buildRunnerFor } from "./bootstrap/stages.ts";
import { loadConfig } from "./config.ts";
import { createDataSource } from "./adapters/persistence/data-source.ts";
import { computeMetrics } from "./adapters/persistence/metrics-query.ts";
import { pruneOldRuns } from "./adapters/persistence/prune.ts";
import type { EventRow } from "./domain/task.ts";
import { GitHubIntake } from "./application/intake.ts";
import { Pipeline } from "./application/pipeline.ts";
import { exec } from "./adapters/process/exec.ts";
import { realDeliverRunner } from "./application/stages/deliver.ts";
import { shipRunner } from "./application/stages/ship.ts";
import { StubStages } from "./application/stages/stubs.ts";
import { verifyRunner } from "./application/stages/verify.ts";

const config = loadConfig();
const db = createDataSource(config.databaseUrl);
await db.initialize();
const applied = await db.runMigrations();
if (applied.length > 0) {
  console.log(`applied migrations: ${applied.map((m) => m.name).join(", ")}`);
}

if (config.retentionDays > 0) {
  try {
    const pruned = await pruneOldRuns(db, config.retentionDays, config.stateDir);
    if (pruned.events > 0 || pruned.stageRuns > 0) {
      console.log(`pruned ${pruned.events} old event(s), ${pruned.stageRuns} old stage run(s)`);
    }
  } catch (error) {
    // A transient DB hiccup here shouldn't block the machine from ever starting to serve —
    // the periodic retry below gets another shot at it.
    console.error("startup prune failed", error);
  }
  setInterval(
    () =>
      void pruneOldRuns(db, config.retentionDays, config.stateDir).catch((error: unknown) => console.error("prune failed", error)),
    24 * 60 * 60 * 1000,
  ).unref();
}

const bus = new Bus();
const stubs = new StubStages();
const watcher = new StreamWatcher(bus);

// `pipeline` is assigned below, after the real stages are built — `latestE2e` is only
// ever called once a stage actually runs, by which point `pipeline` is set.
let pipeline: Pipeline;
const { real, verifyPack } = await buildRealStages(config, watcher, (taskId) =>
  pipeline.latestStageFinish(taskId, "e2e"),
);
/** Verifying runs the project's checks on the host, so it always runs for real; the review pack joins when agents are on. */
const realVerifyRunner = verifyRunner({
  exec,
  runPack: verifyPack,
  stateDir: config.stateDir,
});
/** Delivering and shipping need only git and gh, not a Claude credential, so they always run for real. */
const runnerFor = buildRunnerFor({
  real,
  realDeliverRunner,
  realVerifyRunner,
  shipRunner,
  stubRunnerFor: (stage) => stubs.runnerFor(stage),
});

const METRICS_DEBOUNCE_MS = 2_000;
/** The supervisor pass: orphans escalated, paused timers re-armed, free slots filled. */
const SUPERVISOR_MS = 30_000;
let metricsTimer: NodeJS.Timeout | undefined;

/** Streams fresh 7d metrics once after a burst of transitions, so the board need not poll. */
function scheduleMetrics(): void {
  if (metricsTimer) return;
  metricsTimer = setTimeout(() => {
    metricsTimer = undefined;
    pipeline
      .spentTodayUsd()
      .then((spentTodayUsd) =>
        computeMetrics(db, { since: parseSince("7d"), slots: pipeline.slots, budget: { ...pipeline.budget, spentTodayUsd } }),
      )
      .then(
        (metrics) => bus.publish({ type: "task.metrics", metrics }),
        (error: unknown) => console.error("could not publish metrics", error),
      );
  }, METRICS_DEBOUNCE_MS);
  metricsTimer.unref();
}

/** Streams each logged event, plus the whole task whenever its state may have changed. */
function publish(event: EventRow): void {
  bus.publish({ type: "task.event", event: toEvent(event) });
  if (event.kind === "transition" || event.kind === "task.created") {
    pipeline.get(event.taskId).then(
      (task) => bus.publish({ type: "task.updated", task: toTask(task) }),
      (error: unknown) => console.error("could not publish task update", error),
    );
  }
  if (event.kind === "transition") scheduleMetrics();
}

/** `orc-state` marks orc's session for a task's branch completed when the task closes. */
const orcStateBin = (await exec("which", ["orc-state"])).stdout.trim() || null;

pipeline = new Pipeline(db, runnerFor, {
  onEvent: publish,
  maxConcurrentTasks: config.maxConcurrentTasks,
  budget: { taskUsd: config.taskBudgetUsd, dailyUsd: config.dailyBudgetUsd },
  restartPolicy: config.restartPolicy,
  closeDeps: { exec, worktreeRemove: false, orcStateBin, watcher },
});
const recovered = await pipeline.recover();
if (recovered > 0) console.log(`escalated ${recovered} task(s) left mid-stage by the last run`);
pipeline.startSupervisor(SUPERVISOR_MS);

const app = createApp({ db, pipeline, bus, watcher, stubs });
const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  const agents = [...new Set([...Object.keys(real), "verifying", "delivering", "shipping"])];
  console.log(
    `machine listening on http://${config.host}:${info.port} · real stages: ${agents.join(", ")} · up to ${config.maxConcurrentTasks} task(s) at once`,
  );
});

let intake: GitHubIntake | undefined;
if (config.githubPoll.repos.length > 0) {
  const { repos, intervalMs, label } = config.githubPoll;
  intake = new GitHubIntake({ pipeline, repos, label, intervalMs });
  console.log(`github intake: polling ${repos.join(", ")} every ${intervalMs / 1000}s for ${label}`);
  intake.start();
}

async function shutdown(): Promise<void> {
  intake?.stop();
  pipeline.stopSupervisor();
  server.close();
  await pipeline.shutdown();
  await db.destroy();
  process.exit(0);
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
