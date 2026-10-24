// Entry point for `pnpm dev`: migrates the database, recovers tasks a previous run left
// mid-stage, then serves the API on localhost.
import { serve } from "@hono/node-server";
import type { TaskState } from "@hardness/contracts";

import { createApp } from "./api/app.ts";
import { Bus } from "./api/bus.ts";
import { parseSince } from "./api/metrics.ts";
import { computeMetrics } from "./db/metrics-query.ts";
import { toEvent, toTask } from "./api/serialize.ts";
import { loadConfig } from "./config.ts";
import { createDataSource } from "./db/data-source.ts";
import type { EventRow } from "./domain/task.ts";
import { pruneOldRuns } from "./db/prune.ts";
import { Watcher } from "./herdr/watch.ts";
import { GitHubIntake } from "./intake/github.ts";
import { Pipeline } from "./pipeline/pipeline.ts";
import { exec } from "./sandbox/exec.ts";
import { loadCredential } from "./sandbox/credentials.ts";
import { imageExists, removeLeftoverContainers } from "./sandbox/docker.ts";
import { agentRunners, runAgent } from "./stages/agents.ts";
import type { StageContext, StageResult, StageRunner } from "./stages/runner.ts";
import { ciWatchRunner } from "./stages/ci.ts";
import { e2eRunner, missingQaImageRunner } from "./stages/e2e.ts";
import { evidenceRunner } from "./stages/evidence.ts";
import { realDeliverRunner } from "./stages/deliver.ts";
import { memoryReviewRunner, withMemoryReview } from "./stages/memory.ts";
import { shipRunner } from "./stages/ship.ts";
import { StubStages } from "./stages/stubs.ts";
import { verifyRunner } from "./stages/verify.ts";

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
const watcher = new Watcher(config.herdrBin);

/** Real agents for Triage and Implementer when everything they need is there; stubs otherwise. */
async function realStages(): Promise<Partial<Record<TaskState, StageRunner>>> {
  if (!config.agents) {
    console.log("agents off (MACHINE_AGENTS=off): every stage is a stub");
    return {};
  }
  const credential = await loadCredential();
  if (!credential) {
    console.warn("no Claude credential in ~/.config/hardness: every stage is a stub");
    return {};
  }
  if (!(await imageExists(config.runnerImage))) {
    console.warn(`image ${config.runnerImage} is missing (pnpm runner:build): every stage is a stub`);
    return {};
  }
  const removed = await removeLeftoverContainers();
  if (removed > 0) console.log(`removed ${removed} leftover stage container(s)`);
  const qaImage = await imageExists(config.runnerQaImage);
  if (!qaImage) {
    console.warn(`image ${config.runnerQaImage} is missing (pnpm runner-qa:build): e2e will be skipped`);
  }
  const deps = {
    image: config.runnerImage,
    qaImage: config.runnerQaImage,
    credential,
    worktreesDir: config.worktreesDir,
    stateDir: config.stateDir,
    watcher,
  };
  verifyPack = (context) => runAgent(deps, context, "verifying");
  return {
    ...agentRunners(deps),
    // ci_watch polls the PR's checks on the host and only calls its pack when one is red.
    ci_watch: ciWatchRunner({ exec, runPack: (context) => runAgent(deps, context, "ci_watch") }),
    // e2e skips repos with no web surface; without the QA image it passes with a note.
    e2e: qaImage
      ? e2eRunner({ runPack: (context) => runAgent(deps, context, "e2e") })
      : missingQaImageRunner(),
    // Evidence is script-only, so it runs on the host from what e2e left in the state dir.
    evidence: evidenceRunner({
      stateDir: config.stateDir,
      latestE2e: (taskId) => pipeline.latestStageFinish(taskId, "e2e"),
    }),
    // The memory-review gate has no stage of its own: the retro pack runs after shipping and its
    // proposal rides on the gate; approving applies it at close.
    shipping: withMemoryReview(
      shipRunner,
      memoryReviewRunner({
        runPack: (context) => runAgent(deps, context, "reviewing_memory"),
        stateDir: config.stateDir,
      }),
    ),
  };
}

let verifyPack: ((context: StageContext) => Promise<StageResult>) | null = null;
const real = await realStages();
/** Verifying runs the project's checks on the host, so it always runs for real; the review pack joins when agents are on. */
const realVerifyRunner = verifyRunner({
  exec,
  runPack: verifyPack,
  stateDir: config.stateDir,
});
/** Delivering and shipping need only git and gh, not a Claude credential, so they always run for real. */
const runnerFor = (stage: TaskState): StageRunner =>
  stage === "delivering"
    ? realDeliverRunner
    : stage === "verifying"
      ? realVerifyRunner
      : stage === "shipping"
        ? real.shipping ?? shipRunner
        : real[stage] ?? stubs.runnerFor(stage);

const METRICS_DEBOUNCE_MS = 2_000;
let metricsTimer: NodeJS.Timeout | undefined;

/** Streams fresh 7d metrics once after a burst of transitions, so the board need not poll. */
function scheduleMetrics(): void {
  if (metricsTimer) return;
  metricsTimer = setTimeout(() => {
    metricsTimer = undefined;
    computeMetrics(db, { since: parseSince("7d"), slots: pipeline.slots }).then(
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

const pipeline = new Pipeline(db, runnerFor, {
  onEvent: publish,
  maxConcurrentTasks: config.maxConcurrentTasks,
  closeDeps: { exec, worktreeRemove: false, orcStateBin, watcher },
});
const recovered = await pipeline.recover();
if (recovered > 0) console.log(`escalated ${recovered} task(s) left mid-stage by the last run`);

const app = createApp({ db, pipeline, bus, watcher, stubs });
const server = serve({ fetch: app.fetch, port: config.port, hostname: "127.0.0.1" }, (info) => {
  const agents = [...new Set([...Object.keys(real), "verifying", "delivering", "shipping"])];
  console.log(
    `machine listening on http://127.0.0.1:${info.port} · real stages: ${agents.join(", ")} · up to ${config.maxConcurrentTasks} task(s) at once`,
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
  server.close();
  await pipeline.shutdown();
  await db.destroy();
  process.exit(0);
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
