// Entry point for `pnpm dev`: migrates the database, recovers tasks a previous run left
// mid-stage, then serves the API on localhost.
import { Ledger } from "@hardness/contracts";
import { serve } from "@hono/node-server";

import { createApp } from "./adapters/http/app.ts";
import { Bus } from "./adapters/http/bus.ts";
import { StreamWatcher } from "./adapters/http/watch.ts";
import { parseSince } from "./adapters/http/metrics.ts";
import { toEvent, toTask } from "./adapters/http/serialize.ts";

import { buildRealStages, buildRunnerFor } from "./bootstrap/stages.ts";
import { loadConfig } from "./config.ts";
import { createDataSource, poolSizeFor } from "./adapters/persistence/data-source.ts";
import { computeMetrics } from "./adapters/persistence/metrics-query.ts";
import { pruneOldRuns } from "./adapters/persistence/prune.ts";
import { sweepImages, sweepRunFolders, sweepTaskState, sweepWorktrees } from "./application/sweep.ts";
import type { EventRow } from "./domain/task.ts";
import { GitHubIntake } from "./application/intake.ts";
import { GitHubPulls } from "./application/pulls.ts";
import { RepoMap } from "./application/repo-map.ts";
import { ThreadReplies } from "./application/threads.ts";
import { Pipeline } from "./application/pipeline.ts";
import { PolicyStore } from "./application/policy.ts";
import { exec } from "./adapters/process/exec.ts";
import { realDeliverRunner } from "./application/stages/deliver.ts";
import { shipRunner } from "./application/stages/ship.ts";
import { StubStages } from "./application/stages/stubs.ts";
import { verifyRunner } from "./application/stages/verify.ts";

const config = loadConfig();
const db = createDataSource(config.databaseUrl, poolSizeFor(config.maxConcurrentTasks));
await db.initialize();
const applied = await db.runMigrations();
if (applied.length > 0) {
  console.log(`applied migrations: ${applied.map((m) => m.name).join(", ")}`);
}

/** The nightly housekeeping: old history pruned, closed tasks' checkouts and merged branches
 *  removed, orphaned run folders and superseded runner images gone. Each step fails alone. */
async function sweep(): Promise<void> {
  const step = async (name: string, fn: () => Promise<string | null>) => {
    try {
      const note = await fn();
      if (note) console.log(`sweep: ${note}`);
    } catch (error) {
      console.error(`sweep: ${name} failed`, error);
    }
  };
  await step("prune", async () => {
    if (config.retentionDays <= 0) return null;
    const pruned = await pruneOldRuns(db, config.retentionDays, config.stateDir);
    return pruned.events > 0 || pruned.stageRuns > 0 ? `pruned ${pruned.events} old event(s), ${pruned.stageRuns} old stage run(s)` : null;
  });
  await step("worktrees", async () => {
    const swept = await sweepWorktrees(db, config.worktreeRetentionDays);
    return swept.worktrees > 0 ? `removed ${swept.worktrees} closed task worktree(s), ${swept.branches} merged branch(es)` : null;
  });
  await step("run folders", async () => {
    const removed = await sweepRunFolders(db, config.stateDir);
    return removed > 0 ? `removed ${removed} run folder(s) no stage run owns` : null;
  });
  await step("task state", async () => {
    const removed = await sweepTaskState(db, config.stateDir);
    return removed > 0 ? `removed ${removed} per-task state dir(s) whose task is gone` : null;
  });
  await step("images", async () => {
    const removed = await sweepImages();
    return removed.length > 0 ? `untagged ${removed.join(", ")}` : null;
  });
}
// A transient hiccup here must not stop the machine from serving; tomorrow's pass retries.
await sweep();
setInterval(() => void sweep(), 24 * 60 * 60 * 1000).unref();

const bus = new Bus();
const stubs = new StubStages();
const watcher = new StreamWatcher(bus);

// `pipeline` is assigned below, after the real stages are built — `latestE2e` is only
// ever called once a stage actually runs, by which point `pipeline` is set.
let pipeline: Pipeline;
/** Every repo's PIPELINE.md, read on demand; shared so a bad edit warns once. */
const policies = new PolicyStore();
const { real, verifyPack, checksExec } = await buildRealStages(
  config,
  watcher,
  (taskId) => pipeline.latestStageFinish(taskId, "e2e"),
  policies,
  // The retro reads the task's own record: the last implementing ledger and every run so far.
  async (taskId) => {
    const ledger = Ledger.safeParse((await pipeline.latestStageFinish(taskId, "implementing"))?.detail?.ledger);
    const runs = (await pipeline.stageRuns(taskId)).map((run) => ({
      stage: run.stage,
      attempt: run.attempt,
      outcome: run.outcome ?? run.status,
      turns: run.turns,
      costUsd: run.costUsd === null ? null : Number(run.costUsd),
    }));
    return { ledger: ledger.success ? ledger.data : null, runs };
  },
);
/** Verifying always runs for real: the project's checks in the runner image when there is one
 *  (what implementing installed there does not run on the host), else on the host; the review
 *  pack joins when agents are on. */
const realVerifyRunner = verifyRunner({
  exec: checksExec ?? exec,
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

/** Replies in the thread each task came from, on the moments that matter. */
let replies: ThreadReplies;

/** Streams each logged event, plus the whole task whenever its state may have changed. */
function publish(event: EventRow): void {
  bus.publish({ type: "task.event", event: toEvent(event) });
  void replies.handle(event);
  if (event.kind === "transition" || event.kind === "task.created") {
    pipeline.get(event.taskId).then(
      async (task) => bus.publish({ type: "task.updated", task: toTask(task, await pipeline.taskUsage(task.id)) }),
      (error: unknown) => console.error("could not publish task update", error),
    );
  }
  if (event.kind === "transition") scheduleMetrics();
}

pipeline = new Pipeline(db, runnerFor, {
  onEvent: publish,
  maxConcurrentTasks: config.maxConcurrentTasks,
  maxPerRepo: config.maxPerRepo,
  maxPerStage: config.maxPerStage,
  budget: { taskUsd: config.taskBudgetUsd, dailyUsd: config.dailyBudgetUsd },
  restartPolicy: config.restartPolicy,
  closeDeps: { exec, worktreeRemove: false, watcher },
  policies,
  onAlert: (alert) => {
    console.warn(`budget: ${alert.scope} at ${alert.pct}% ($${alert.spentUsd.toFixed(2)} of $${alert.limitUsd.toFixed(2)})${alert.repo ? ` · ${alert.repo}` : ""}`);
    bus.publish({ type: "budget.alert", alert });
  },
});
replies = new ThreadReplies({ pipeline, enabled: config.threadReplies, ...(config.slack ? { slack: config.slack } : {}) });
const recovered = await pipeline.recover();
if (recovered > 0) console.log(`escalated ${recovered} task(s) left mid-stage by the last run`);
pipeline.startSupervisor(SUPERVISOR_MS);

/** Where each `owner/name` lives on this machine, for GitHub intake and the PR inbox alike. */
const repoMap = new RepoMap({ map: config.repoMap, reposDir: config.reposDir });
const pulls = new GitHubPulls({
  intervalMs: config.githubPrs.intervalMs,
  resolveRepo: (repo) => repoMap.resolve(repo),
  rememberRepo: (repo, path) => repoMap.remember(repo, path),
  findTask: async (repo, number) => {
    const task = await pipeline.findBySource(repo, number, "github_pr");
    return task && task.state !== "closed" && task.route !== "feature" ? { id: task.id, state: task.state, route: task.route } : null;
  },
  publish: (snapshot) => bus.publish({ type: "github.prs", snapshot }),
});
const app = createApp({ db, pipeline, bus, watcher, stubs, pulls });
const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  const agents = [...new Set([...Object.keys(real), "verifying", "delivering", "shipping"])];
  console.log(
    `machine listening on http://${config.host}:${info.port} · real stages: ${agents.join(", ")} · up to ${config.maxConcurrentTasks} task(s) at once`,
  );
});

if (config.githubPrs.enabled) {
  console.log(`github prs: polling every open PR involving you every ${config.githubPrs.intervalMs / 1000}s`);
  pulls.start();
}

let intake: GitHubIntake | undefined;
if (config.githubPoll.repos.length > 0) {
  const { repos, intervalMs, label } = config.githubPoll;
  intake = new GitHubIntake({ pipeline, repos, label, intervalMs, resolveRepo: (repo) => repoMap.resolve(repo) });
  console.log(`github intake: polling ${repos.join(", ")} every ${intervalMs / 1000}s for ${label}`);
  intake.start();
}

async function shutdown(): Promise<void> {
  intake?.stop();
  pulls.stop();
  pipeline.stopSupervisor();
  server.close();
  await pipeline.shutdown();
  await db.destroy();
  process.exit(0);
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
