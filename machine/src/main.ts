// Entry point for `pnpm dev`: migrates the database, recovers tasks a previous run left
// mid-stage, then serves the API on localhost.
import { expireKept, keepFolder } from "./application/kept-sandboxes.ts";
import { hostFreshWorkspace, removeLeftovers } from "./adapters/git/clone.ts";
import { type BudgetAlert, type EvidenceContext, FACTORY_DEFAULTS, Ledger, PrAction, type PullRequest, WAITING_ON_USER, isTerminal } from "@hardness/contracts";
import { serve } from "@hono/node-server";

import { createApp } from "./adapters/http/app.ts";
import { Bus } from "./adapters/http/bus.ts";
import { StreamWatcher } from "./adapters/http/watch.ts";
import { parseSince } from "./adapters/http/metrics.ts";
import { toEvent, toTask } from "./adapters/http/serialize.ts";

import { buildTelemetry } from "./bootstrap/telemetry.ts";
import { buildPackRuns, buildRealStages, buildRunnerFor } from "./bootstrap/stages.ts";
import { loadConfig } from "./config.ts";
import { createDataSource, poolSizeFor } from "./adapters/persistence/data-source.ts";
import { computeMetrics } from "./adapters/persistence/metrics-query.ts";
import { pruneOldRuns, prunePackRuns, pruneTombstones, TOMBSTONE_RETENTION_DAYS } from "./adapters/persistence/prune.ts";
import { AUTO_ARCHIVE_GATES, type SlaRow, applySlaActions } from "./application/sla-actions.ts";
import { sweepEvidenceStore } from "./application/evidence-store.ts";
import { sweepImages, sweepJiraIntakeRuns, sweepRunFolders, sweepSlackTriageRuns, sweepTaskState, sweepWorktrees } from "./application/sweep.ts";
import type { EventRow } from "./domain/task.ts";
import { DecisionLog } from "./application/decision-log.ts";
import { DecisionTruth, tagged } from "./application/decision-truth.ts";
import { escalationTruthWriter, groundTruthWriter } from "./application/ground-truth.ts";
import { commitsSince, headCommit } from "./adapters/git/worktree.ts";
import type { PlanDeps } from "./application/stages/plan.ts";
import type { Decide } from "./application/stages/check-decide.ts";
import { retroFactsOf } from "./application/stages/memory.ts";
import { shippedStream } from "./application/ship-loop.ts";
import type { ShipDecide } from "./application/stages/ship-fixes.ts";
import type { TriageSignalDeps } from "./application/stages/triage-signals.ts";
import { createIssueClassifier } from "./application/classify.ts";
import { searchCards } from "./domain/card-search.ts";
import { GitHubIntake } from "./application/intake.ts";
import { GitHubPulls } from "./application/pulls.ts";
import { SlackInbox } from "./application/slack-inbox.ts";
import { noTokenSlack } from "./application/slack.ts";
import { createSlackTriager } from "./application/stages/slack-triage-runner.ts";
import { PgSlackStore } from "./adapters/persistence/slack-store.ts";
import { SocketMode } from "./adapters/slack/socket-mode.ts";
import { createSlack } from "./adapters/slack/web-api.ts";
import { createPrTask } from "./application/pr-tasks.ts";
import { prFollowUpRunner } from "./application/stages/pr-address.ts";
import { postVerdictRunner } from "./application/stages/pr-review.ts";
import { RepoMap } from "./application/repo-map.ts";
import { ThreadReplies } from "./application/threads.ts";
import { noTokenJira } from "./application/jira.ts";
import { createJira } from "./adapters/jira/rest.ts";
import { JiraIntake, reposUnder } from "./application/jira-intake.ts";
import { JiraSync } from "./application/jira-sync.ts";
import { JiraTasks, TokenExpiry } from "./application/jira-tasks.ts";
import { JiraWatch } from "./application/jira-watch.ts";
import { SlaClocks } from "./application/sla.ts";
import { createJiraTriager } from "./application/stages/jira-intake-runner.ts";
import { PgPackRunStore } from "./adapters/persistence/pack-run-store.ts";
import { MINUTE_MS, Ticker } from "./application/ticker.ts";
import { graphifyGraph } from "./adapters/graph/graphify.ts";
import { imageId, imageLabel, runSandbox } from "./adapters/docker/docker.ts";
import { LOCKFILES, type EnvRecord, envOf } from "./domain/env-hash.ts";
import { lockfilesAt } from "./adapters/git/worktree.ts";
import { GraphWatch } from "./application/graph-watch.ts";
import { imageSpecOf } from "./domain/image-spec.ts";
import { repoHealthOf } from "./application/repo-health.ts";
import { EngineBudgetWatch, engineBudgetGate, gatedCredentials, runtimeKillSwitch } from "./application/engine-gates.ts";
import { PgTaskStore } from "./adapters/persistence/task-store.ts";
import { machineCredentials } from "./adapters/credentials/index.ts";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { configureMachineRepos, configureWorkspacesDir } from "./adapters/git/machine-repo.ts";
import { Pipeline } from "./application/pipeline.ts";
import { PolicyStore } from "./application/policy.ts";
import { exec } from "./adapters/process/exec.ts";
import { createGitHub } from "./adapters/github/octokit.ts";
import { taskDiff } from "./adapters/git/diff.ts";
import { noTokenGitHub } from "./application/github.ts";
import { realDeliverRunner } from "./application/stages/deliver.ts";
import { shipRunner } from "./application/stages/ship.ts";
import { StubStages } from "./application/stages/stubs.ts";
import { verifyRunner } from "./application/stages/verify.ts";

const config = loadConfig();
// Each card has a git directory of the machine's own here, never mounted into a container.
configureMachineRepos(join(config.stateDir, "repos"));
configureWorkspacesDir(config.worktreesDir);
const db = createDataSource(config.databaseUrl, poolSizeFor(config.maxConcurrentTasks));
await db.initialize();
const applied = await db.runMigrations();
if (applied.length > 0) {
  console.log(`applied migrations: ${applied.map((m) => m.name).join(", ")}`);
}

/** Every repo's luna.yaml (or older PIPELINE.md), read on demand; shared so a bad edit warns once. */
const policies = new PolicyStore();
/** Run traces: a local Laminar (`MACHINE_TRACES`, `LMNR_*`); the no-op without a key. Built before
 *  the pipeline so the first stage run after boot is traced. */
const telemetry = await buildTelemetry(config.traces);
/** What each decision pack call leaves (context, answer, verdicts), for evals; off with MACHINE_DECISIONS=off. */
const decisionLog = new DecisionLog({ stateDir: config.stateDir, enabled: config.decisions.enabled });
/** What later facts say a decision should have been, written onto its record; each is a `decision.truth` event on the task. */
const decisionTruth = new DecisionTruth(decisionLog, { told: async (e) => void (e.taskId && (await pipeline.logDecisionTruth(e.taskId, e))) });
if (config.traces.mode !== "off") {
  console.log(`traces ${telemetry.mode === "off" ? "off (backend unavailable)" : telemetry.mode} · Laminar at ${config.traces.laminar.baseUrl}:${config.traces.laminar.httpPort}`);
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
  await step("pack runs", async () => {
    const pruned = await prunePackRuns(db, config.retentionDays);
    return pruned > 0 ? `pruned ${pruned} pack run(s) older than ${config.retentionDays} day(s)` : null;
  });
  await step("tombstones", async () => {
    const pruned = await pruneTombstones(db);
    return pruned > 0 ? `pruned ${pruned} task tombstone(s) older than ${TOMBSTONE_RETENTION_DAYS} days` : null;
  });
  await step("worktrees", async () => {
    const swept = await sweepWorktrees(db, config.worktreeRetentionDays);
    return swept.worktrees > 0 ? `removed ${swept.worktrees} closed task worktree(s), ${swept.branches} merged branch(es)` : null;
  });
  await step("workspace leftovers", async () => {
    const removed = await removeLeftovers(config.worktreesDir);
    return removed.length > 0 ? `removed ${removed.length} leftover scratch folder(s) and bundle copy(ies)` : null;
  });
  await step("kept sandboxes", async () => {
    const removed = await expireKept({ stateDir: config.stateDir, keepHours: FACTORY_DEFAULTS.sandbox.keep_hours });
    return removed.length > 0 ? `removed ${removed.length} kept sandbox folder(s) past their keep` : null;
  });
  await step("run folders", async () => {
    const removed = await sweepRunFolders(db, config.stateDir);
    return removed > 0 ? `removed ${removed} run folder(s) no stage run owns` : null;
  });
  await step("task state", async () => {
    const removed = await sweepTaskState(db, config.stateDir);
    return removed > 0 ? `removed ${removed} per-task state dir(s) whose task is gone` : null;
  });
  await step("evidence store", async () => {
    // A repo's `evidence.retention_days` over the machine's; a task whose repo is gone takes the machine's.
    const retention = async (taskId: string): Promise<number> => {
      const rows: { repo_path: string | null }[] = await db.query("select repo_path from tasks where id::text = $1", [taskId]);
      const repo = rows[0]?.repo_path ?? null;
      return (repo ? (await policies.for(repo)).evidenceRetentionDays : null) ?? config.retentionDays;
    };
    const removed = await sweepEvidenceStore(config.stateDir, retention, new Date());
    return removed > 0 ? `removed ${removed} evidence pack copy(ies) past retention` : null;
  });
  await step("decision records", async () => {
    const removed = await decisionLog.sweep(config.decisions.retentionDays);
    return removed > 0 ? `removed ${removed} decision record(s) past ${config.decisions.retentionDays} days` : null;
  });
  await step("slack triage runs", async () => {
    const removed = await sweepSlackTriageRuns(config.stateDir, config.retentionDays);
    return removed > 0 ? `removed ${removed} failed slack triage run folder(s)` : null;
  });
  await step("jira intake runs", async () => {
    const removed = await sweepJiraIntakeRuns(config.stateDir, config.retentionDays);
    return removed > 0 ? `removed ${removed} failed jira intake run folder(s)` : null;
  });
  await step("images", async () => {
    const removed = await sweepImages();
    return removed.length > 0 ? `untagged ${removed.join(", ")}` : null;
  });
}
// A transient hiccup here must not stop the machine from serving; tomorrow's pass retries.
await sweep();
setInterval(() => void sweep(), 24 * 60 * 60 * 1000).unref();

/** One GitHub client for every call the machine makes; without a token each call says so. */
const github = config.githubToken ? createGitHub(config.githubToken) : noTokenGitHub();
if (!config.githubToken) console.warn("no GITHUB_TOKEN (or GH_TOKEN): every GitHub call will fail with that reason until one is set");

const bus = new Bus();
const stubs = new StubStages();
const watcher = new StreamWatcher(bus);

// `pipeline` is assigned below, after the real stages are built — `latestE2e` is only
// ever called once a stage actually runs, by which point `pipeline` is set.
let pipeline: Pipeline;
/** One Graphify code graph per repo, built from its default branch in the runner image. */
// A graph is built in the repository's own image, so the Graphify that built it is the one that reads it; the resolver is bound
// once the stages (and with them the repository images) exist.
let graphImage: (repoPath: string, signal?: AbortSignal) => Promise<string> = async () => config.runnerImage;
const graph = graphifyGraph({ stateDir: config.stateDir, image: (repoPath, signal) => graphImage(repoPath, signal), imageId, graphifyVersion: () => imageLabel(config.runnerImage, "dev.hardness.graphify"), worktreesDir: config.worktreesDir, sandbox: runSandbox });
/** The graph watch, built below once the pipeline and the repo map exist; a stage with no graph asks it for a first build. */
let graphWatch: GraphWatch | null = null;
/** Each engine's credential as every part of the machine sees it: an engine on a runtime
 *  MACHINE_DISABLE_RUNTIMES turned off, or at a monthly cap (MACHINE_ENGINE_BUDGETS, a repo's
 *  luna.yaml `budget.engines`), is unavailable, as if its credential were missing. */
const engineSpend = new PgTaskStore(db);
/** A spend crossing 80, 90 or 100% of a ceiling: logged, and on `/events` for the board. */
const raiseAlert = (alert: BudgetAlert) => {
  console.warn(`budget: ${alert.scope}${alert.engine ? ` ${alert.engine}` : ""} at ${alert.pct}% ($${alert.spentUsd.toFixed(2)} of $${alert.limitUsd.toFixed(2)})${alert.repo ? ` · ${alert.repo}` : ""}`);
  bus.publish({ type: "budget.alert", alert });
};
const repoEngineBudgets = async (repo: string) => (await policies.for(repo)).engineBudgets;
/** The monthly caps per engine: alerts as a run's cost crosses them, and each engine's standing for `GET /engines`. */
const engineBudgets = new EngineBudgetWatch({ budgets: config.engineBudgets, repoBudgets: repoEngineBudgets, spend: engineSpend, onAlert: raiseAlert });
const credentials = gatedCredentials(machineCredentials(), [
  runtimeKillSwitch(config.disabledRuntimes),
  engineBudgetGate({ budgets: config.engineBudgets, repoBudgets: repoEngineBudgets, spend: engineSpend }),
]);
if (config.disabledRuntimes.length > 0) console.log(`runtimes off (MACHINE_DISABLE_RUNTIMES): ${config.disabledRuntimes.join(", ")}`);
/** Triage's signals: the classifier is built after the stages (it needs PackRuns), so it is bound below. */
const triageSignals: TriageSignalDeps = { classify: null, graph, policy: (repoPath) => policies.for(repoPath), save: (id, patch) => engineSpend.updateTask(id, patch) };
/** The plan stage's decisions run through PackRuns, which is built below: bound once it exists. */
const planDecisions: { decide: PlanDeps["decide"] } = { decide: null };
/** Build's red and scope checks run through PackRuns too: bound once it exists. */
const buildDecisions: { decide: Decide | null; budget?: (taskId: string) => Promise<{ spent: boolean; minutesLeft: number }> } = { decide: null };
/** Verify's finding_classify (and e2e's failure cause) run through PackRuns as the `verify` client: bound once it exists. */
const verifyDecisions: { decide: Decide | null } = { decide: null };
/** Evidence's format decision runs through PackRuns as the `evidence` client: bound once it exists. */
const evidenceDecisions: { decide: ((context: EvidenceContext, repoPath: string | null) => Promise<Record<string, unknown>>) | null } = { decide: null };
/** Ship's review-loop decisions run through PackRuns as the `ship` client: bound once it exists. */
const shipDecisions: { decide: ShipDecide | null } = { decide: null };
const { real, verifyPack, checksExec, agentDeps } = await buildRealStages(
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
      engine: run.engine,
      durationMs: run.startedAt && run.endedAt ? run.endedAt.getTime() - run.startedAt.getTime() : null,
    }));
    return { ledger: ledger.success ? ledger.data : null, runs };
  },
  github,
  credentials,
  triageSignals,
  planDecisions,
  { graph, ensure: (repoPath) => graphWatch?.ensure(repoPath), rebuild: (repoPath) => graphWatch?.requestRebuild(repoPath) },
  buildDecisions,
  verifyDecisions,
  {
    latestFinish: (taskId, stage) => pipeline.latestStageFinish(taskId, stage),
    save: (id, patch) => engineSpend.updateTask(id, patch),
    load: async (id) => (await pipeline.get(id)).evidence,
    decisions: evidenceDecisions,
  },
  shipDecisions,
  async (taskId) => {
    const [task, events, runs, finish] = await Promise.all([pipeline.get(taskId), pipeline.events(taskId), pipeline.stageRuns(taskId), pipeline.latestStageFinish(taskId, "implementing")]);
    const ledger = Ledger.safeParse(finish?.detail?.ledger);
    return retroFactsOf({ task, ledger: ledger.success ? ledger.data : null, events, runs: runs.length });
  },
  decisionTruth,
  // Triage's card_search: the task's own repository's cards, from the board the pipeline keeps.
  { search: async ({ repoPath, selfId, selfSource, query }) => searchCards(await pipeline.list(), query, { repoPath, selfId, selfSource, now: new Date() }) },
);
if (agentDeps) {
  graphImage = agentDeps.repoImageOf;
  agentDeps.imageEvents.sink = (event) => { if (event.taskId) void pipeline.recordImageEvent(event.taskId, event).catch(() => undefined); else console.warn(`repository image: ${JSON.stringify(event)}`); };
}
/** Verifying always runs for real: the project's checks in the runner image when there is one
 *  (what implementing installed there does not run on the host), else on the host; the review
 *  pack joins when agents are on. */
/** The fresh clone Verify and fixes run on, with a kept folder registered so it ends after sandbox.keep_hours. */
const keptFresh = { ...hostFreshWorkspace, keep: (path: string, taskId: string, runId: string) => keepFolder({ stateDir: config.stateDir, taskId, runId, path, keepHours: FACTORY_DEFAULTS.sandbox.keep_hours }) };
const realVerifyRunner = verifyRunner({
  exec: checksExec,
  runPack: verifyPack,
  // Verify runs on a fresh clone at the head commit, never in the folder Build used.
  fresh: keptFresh,
  // The environment Build recorded, and the one Verify's fresh clone has.
  buildEnv: async (taskId) => {
    const env = (await pipeline.latestStageFinish(taskId, "implementing"))?.detail?.env as EnvRecord | undefined;
    return env && typeof env.hash === "string" ? env : null;
  },
  imageOf: agentDeps ? (repoPath, signal) => agentDeps.repoImageOf(repoPath, signal) : async () => config.runnerImage,
  // The image Verify chose once (the sandboxes run in it) is the one compared; only a caller that chose none resolves the repository's image here.
  envOf: async (path, commit, repoPath, image) => envOf({ image: await imageId(image ?? (agentDeps && repoPath ? await agentDeps.repoImageOf(repoPath) : config.runnerImage)), lockfiles: await lockfilesAt(path, commit, LOCKFILES), commit }),
  graph,
  stateDir: config.stateDir,
  get decide() {
    return verifyDecisions.decide;
  },
  policy: async (repoPath) => {
    const { checks, services, decisions, factory } = await policies.for(repoPath);
    return { checks, services, decisions, verify: factory.verify };
  },
});
/** Delivering and shipping need only git and gh, not a Claude credential, so they always run for real. */
const runnerFor = buildRunnerFor({
  real,
  realDeliverRunner: realDeliverRunner(github),
  realVerifyRunner,
  shipRunner: shipRunner(github),
  stubRunnerFor: (stage) => stubs.runnerFor(stage),
  pr: {
    // A PR task runs the project's checks before pushing, never the review pack.
    checksOnlyVerifyRunner: verifyRunner({ exec: checksExec, runPack: null, stateDir: config.stateDir }),
    followUpRunner: prFollowUpRunner({
      github,
      exec,
      latestAnswer: async (taskId) => (await pipeline.latestStageFinish(taskId, "addressing"))?.detail?.answer,
    }),
    postVerdictRunner: postVerdictRunner({ github }),
  },
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
/** Moves the linked Jira issue as the task moves, per the repo's luna.yaml. */
let jiraSync: JiraSync;
/** The ticket clocks, computed whenever a task is serialized. */
let slaClocks: SlaClocks;

/** Streams each logged event, plus the whole task whenever its state (or its Jira link) may have changed. */
function publish(event: EventRow): void {
  bus.publish({ type: "task.event", event: toEvent(event) });
  const shipped = shippedStream(event);
  if (shipped) bus.publish(shipped);
  void replies.handle(event);
  void jiraSync.handle(event);
  if (event.kind === "transition" || event.kind === "task.created" || event.kind === "approval.partial" || event.kind.startsWith("jira.")) {
    pipeline.get(event.taskId).then(
      async (task) =>
        bus.publish({ type: "task.updated", task: toTask(task, await pipeline.taskUsage(task.id), await slaClocks.for(task), await pipeline.glance(task.id)), seq: Number(task.seq) }),
      (error: unknown) => console.error("could not publish task update", error),
    );
  }
  if (event.kind === "transition") scheduleMetrics();
}

pipeline = new Pipeline(db, runnerFor, {
  // A resumed or closed card ends its kept sandbox: the extra folders go, the clone and its kept ref stay.
  releaseKept: async (taskId) => void (await expireKept({ stateDir: config.stateDir, keepHours: FACTORY_DEFAULTS.sandbox.keep_hours, taskId })),
  onEvent: publish,
  // The outside-approver rule reads CODEOWNERS through the code graph port and nothing a model wrote.
  owners: (repoPath, paths) => graph.owners(repoPath, paths),
  maxConcurrentTasks: config.maxConcurrentTasks,
  maxPerRepo: config.maxPerRepo,
  maxPerStage: config.maxPerStage,
  budget: { taskUsd: config.taskBudgetUsd, dailyUsd: config.dailyBudgetUsd },
  restartPolicy: config.restartPolicy,
  closeDeps: { exec, worktreeRemove: false, watcher, github },
  ...(config.groundTruth ? { groundTruth: groundTruthWriter(config.stateDir), escalationTruth: escalationTruthWriter(config.stateDir), commitsSince, headOf: headCommit } : {}),
  truth: decisionTruth,
  escalationDecide: buildDecisions,
  policies,
  // The queue's usage windows go by the engine each stage really runs on, credential fallback included.
  ...(agentDeps ? { credentials: agentDeps.credentials } : {}),
  jiraSite: config.jira?.site ?? null,
  onAlert: raiseAlert,
  engineBudgets,
  telemetry,
});
replies = new ThreadReplies({ pipeline, github, enabled: config.threadReplies, ...(config.slack ? { slack: config.slack } : {}), slackPort: () => (config.slackInbox.userToken ? slackApi : null) });
/** One Jira client for every call; without the three variables each call says so and nothing syncs. */
const jiraApi = config.jira ? createJira(config.jira) : noTokenJira();
const jiraExpiry = new TokenExpiry(config.jira?.tokenExpiresAt ?? null);
jiraSync = new JiraSync({ pipeline, jira: jiraApi, enabled: config.jira !== null, boardUrl: `http://${config.host}:${config.port}` });
slaClocks = new SlaClocks({ pipeline, defaults: { gate: config.sla.gateSecs, cycle: config.sla.cycleSecs } });
const recovered = await pipeline.recover();
if (recovered > 0) console.log(`escalated ${recovered} task(s) left mid-stage by the last run`);
pipeline.startSupervisor(SUPERVISOR_MS);

/** Where each `owner/name` lives on this machine, for GitHub intake and the PR inbox alike. */
const repoMap = new RepoMap({ map: config.repoMap, reposDir: config.reposDir, file: join(config.stateDir, "repo-links.json") });
const pulls = new GitHubPulls({
  github,
  intervalMs: config.githubPrs.intervalMs,
  resolveRepo: (repo) => repoMap.resolve(repo),
  rememberRepo: (repo, path) => repoMap.remember(repo, path),
  findTask: async (repo, number) => {
    const task = await pipeline.findBySource(repo, number, "github_pr");
    const route = task ? PrAction.safeParse(task.route) : null;
    return task && route?.success && !isTerminal(task.state) ? { id: task.id, state: task.state, route: route.data } : null;
  },
  publish: (snapshot) => bus.publish({ type: "github.prs", snapshot }),
});
const prTasks = {
  dispatch: (pr: PullRequest, action: PrAction) => createPrTask({ worktreesDir: config.worktreesDir, pipeline }, pr, action),
};
/** The Slack inbox: your user token reads and posts; the slack_triage pack triages in the stage
 *  container with the same image and credential as the stages, so it is off when they are. */
const slackApi = config.slackInbox.userToken ? createSlack(config.slackInbox.userToken) : noTokenSlack();
const slackStore = new PgSlackStore(db);
const triager = agentDeps ? createSlackTriager({ ...agentDeps, store: slackStore }) : null;
const slackInbox = new SlackInbox({
  slack: slackApi,
  triager,
  store: slackStore,
  intervalMs: config.slackInbox.intervalMs,
  publish: (snapshot) => bus.publish({ type: "slack.items", snapshot }),
  findTask: (id) => pipeline.get(id).catch(() => null),
  linkPr: (refs) => {
    for (const ref of refs) {
      const pr = pulls.find(ref.repo, ref.number);
      if (pr) return { repo: pr.repo, number: pr.number, split: pr.split };
    }
    return null;
  },
  createTask: (input) => pipeline.createTask(input),
  markRead: config.slackInbox.markRead,
  rulesPath: config.slackInbox.rulesPath,
  socketToken: config.slackInbox.appToken,
  retentionDays: config.retentionDays,
});
/** Packs on demand (`POST /runs`): the stage image, each call with its own engine's credential;
 *  off only with MACHINE_AGENTS=off. Their cost counts toward the day's ceiling, which they obey. */
const packRuns = buildPackRuns(config, {
  ...(config.egress.enabled && agentDeps?.egress ? { egress: agentDeps.egress } : {}),
  credentials,
  store: new PgPackRunStore(db),
  budget: { dailyUsd: pipeline.budget.dailyUsd, spentTodayUsd: () => pipeline.spentTodayUsd() },
  engineBudgets,
  telemetry,
  decisions: decisionLog,
  // A usage limit moves a call to a fallback engine, never to one whose window the pipeline holds.
  latched: () => pipeline.slots.latched.map((latch) => latch.owner),
});
// A run folder a crash left holds a client's context: never kept.
await packRuns?.clearLeftovers();
/** Intake's first read of a new issue: triage_signals on Jev through the same PackRuns, recorded
 *  as the `intake` client. Without a Jev credential it answers nothing and intake runs as before. */
const classifier = packRuns ? createIssueClassifier({ runs: packRuns }) : null;
if (classifier) triageSignals.classify = (issue, _repoPath, options) => classifier.classify(issue, options);
if (packRuns) planDecisions.decide = async (pack, plan) => tagged(await packRuns.run({ pack, context: { plan }, stage: "plan" }, "plan"));
if (packRuns) verifyDecisions.decide = async (pack, check) => tagged(await packRuns.run({ pack, context: { check }, stage: "verify" }, "verify"));
if (packRuns) evidenceDecisions.decide = async (evidence) => tagged(await packRuns.run({ pack: "evidence_format", context: { evidence }, stage: "evidence" }, "evidence"));
if (packRuns) shipDecisions.decide = async (pack, ship) => tagged(await packRuns.run({ pack, context: { ship }, stage: "ship" }, "ship"));
buildDecisions.budget = (taskId) => pipeline.buildBudgetState(taskId);
if (packRuns) buildDecisions.decide = async (pack, check) => tagged(await packRuns.run({ pack, context: { check }, stage: "build" }, "build"));
const jiraTasks = config.jira ? new JiraTasks({ jira: jiraApi, site: config.jira.site, pipeline, expiry: jiraExpiry }) : undefined;
/** Every checkout the machine knows: the repo map, the repos dir's remembered ones, and the repos of live tasks. */
const knownRepos = async (): Promise<string[]> => {
  const known = [...Object.values(config.repoMap), ...(await repoMap.remembered())];
  for (const task of await pipeline.list()) if (task.repoPath && !isTerminal(task.state)) known.push(task.repoPath);
  return [...new Set(known)];
};
/** A person approves the exact base the repository's luna.yaml (on the user's checkout) names now; any other reference is refused. */
const approveBase = async (repo: string, base: string): Promise<{ ok: true } | { ok: false; reason: string }> => {
  if (!agentDeps) return { ok: false, reason: "repository images are off on this machine" };
  if (!(await knownRepos()).includes(repo)) return { ok: false, reason: "the machine does not know that repository" };
  const spec = imageSpecOf((await policies.for(repo)).factory.sandbox.image);
  if (spec.kind !== "repo" || spec.base !== base) return { ok: false, reason: "that is not the base in the repository's luna.yaml now" };
  await agentDeps.approvals.approve(repo, base);
  agentDeps.repoImages.approved(repo);
  return { ok: true };
};
const app = createApp({
  approveBase,
  repoHealth: () =>
    repoHealthOf({
      repos: [],
      knownRepos,
      policy: (repoPath) => policies.for(repoPath),
      machineImage: config.runnerImage,
      images: { status: (repoPath) => agentDeps?.repoImages.status(repoPath) ?? null, pending: async (repoPath) => (await agentDeps?.repoImages.pending(repoPath)) ?? null },
      graph,
      watch: { health: (repoPath) => graphWatch?.health(repoPath) ?? { building: false, lastFailure: null } },
    }),
  db,
  pipeline,
  bus,
  watcher,
  stubs,
  pulls,
  prTasks,
  slack: slackInbox,
  ...(jiraTasks ? { jira: jiraTasks } : {}),
  ...(packRuns ? { runs: packRuns } : {}),
  sla: (task) => slaClocks.for(task),
  slaAll: (tasks) => slaClocks.forAll(tasks),
  taskDiff: (worktreePath, repoPath, file) => taskDiff(exec, worktreePath, repoPath, file),
  credentials,
  engineBudgets,
  access: { host: config.host, port: config.port, token: config.apiToken },
});
const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  const agents = [...new Set([...Object.keys(real), "verifying", "delivering", "shipping"])];
  console.log(
    `machine listening on http://${config.host}:${info.port} · real stages: ${agents.join(", ")} · up to ${config.maxConcurrentTasks} task(s) at once${config.apiToken ? " · API token required" : ""}`,
  );
});

if (config.githubPrs.enabled) {
  console.log(`github prs: polling every open PR involving you every ${config.githubPrs.intervalMs / 1000}s`);
  pulls.start();
}

let socket: SocketMode | undefined;
let digestTimer: NodeJS.Timeout | undefined;
if (config.slackInbox.enabled && config.slackInbox.userToken) {
  const { intervalMs, appToken, digestAt } = config.slackInbox;
  console.log(`slack inbox: polling mentions, DMs, threads and watches every ${intervalMs / 1000}s${triager ? " · triage by the slack_triage pack (haiku)" : " · agents off, no triage"}${appToken ? " · Socket Mode on" : ""}`);
  slackInbox.start();
  if (appToken) {
    socket = new SocketMode({
      openSocket: () => slackApi.openSocket(appToken),
      onEvent: (event) => slackInbox.handleSocketEvent(event),
      onState: (state) => slackInbox.setSocketState(state),
    });
    void socket.start();
  }
  if (digestAt) {
    /** Posts the digest to your own DM at `HH:MM` local time, every day. */
    const scheduleDigest = () => {
      const now = new Date();
      const next = new Date(now);
      next.setHours(digestAt.hour, digestAt.minute, 0, 0);
      if (next <= now) next.setDate(next.getDate() + 1);
      digestTimer = setTimeout(() => {
        slackInbox.postDigest().catch((error: unknown) => console.warn("slack inbox: digest failed", error));
        scheduleDigest();
      }, next.getTime() - now.getTime());
      digestTimer.unref();
    };
    scheduleDigest();
  }
} else if (config.slackInbox.enabled) {
  console.log("slack inbox: off until MACHINE_SLACK_USER_TOKEN is set");
}

let intake: GitHubIntake | undefined;
if (config.githubPoll.repos.length > 0) {
  const { repos, intervalMs, label } = config.githubPoll;
  intake = new GitHubIntake({ pipeline, github, repos, label, intervalMs, resolveRepo: (repo) => repoMap.resolve(repo), classifier });
  console.log(`github intake: polling ${repos.join(", ")} every ${intervalMs / 1000}s for ${label}`);
  intake.start();
}

/** Jira: the linked issues refreshed every five minutes, and each repo's intake JQL polled at its own `every`. */
let jiraWatch: JiraWatch | undefined;
let jiraIntake: JiraIntake | undefined;
if (config.jira) {
  jiraWatch = new JiraWatch({
    pipeline,
    jira: jiraApi,
    intervalMs: 5 * MINUTE_MS,
    expiry: jiraExpiry,
    retryBlocked: (task) => jiraSync.retry(task),
    publish: (task) =>
      void Promise.all([slaClocks.for(task), pipeline.glance(task.id)]).then(([sla, glance]) => bus.publish({ type: "task.updated", task: toTask(task, null, sla, glance), seq: Number(task.seq) })),
  });
  jiraWatch.start();
  const jiraTriager = agentDeps ? createJiraTriager(agentDeps) : null;
  jiraIntake = new JiraIntake({
    pipeline,
    jira: jiraApi,
    policies,
    triager: jiraTriager,
    classifier,
    // Every checkout the machine knows: the repo map, the repos dir, and the repos of existing tasks.
    repos: async () => {
      const known = [...Object.values(config.repoMap), ...(await reposUnder(config.reposDir, { readdir, exists: existsSync }))];
      for (const task of await pipeline.list()) if (task.repoPath) known.push(task.repoPath);
      return [...new Set(known)];
    },
  });
  jiraIntake.start();
  console.log(`jira: ${config.jira.site} · linked issues refreshed every 5m · intake per repo's luna.yaml${jiraTriager ? " through the jira_intake pack (sonnet)" : " (agents off: issues imported as written)"}`);
} else {
  console.log("jira: off until MACHINE_JIRA_SITE, MACHINE_JIRA_EMAIL and MACHINE_JIRA_TOKEN are set");
}

/** The graph watch: each repo's graph is rebuilt when its default branch moves, and built when it has none. */
graphWatch = new GraphWatch({
  graph,
  policies,
  repos: knownRepos,
});
const graphTicker = config.agents && config.graphIntervalSecs !== null ? new Ticker(() => void graphWatch?.tick(), config.graphIntervalSecs * 1000) : null;
if (graphTicker) {
  graphTicker.start();
  void graphWatch?.tick();
  console.log(`graph: each repo's code graph rebuilt when its default branch moves, checked every ${config.graphIntervalSecs}s`);
} else {
  console.log("graph: off (MACHINE_GRAPH_INTERVAL=off or agents off); stages run without a code graph");
}

/** The minute tick: a gate goes overdue, a stage passes 80% of its target, with no event to say so. */
const slaTicker = new Ticker(() => {
  void pipeline
    .list()
    .then((tasks) => slaClocks.flipped(tasks))
    .then(async (flipped) => {
      for (const { task, sla } of flipped) bus.publish({ type: "task.updated", task: toTask(task, await pipeline.taskUsage(task.id), sla, await pipeline.glance(task.id)), seq: Number(task.seq) });
    })
    .then(() => pipeline.list())
    .then(async (tasks) => {
      // A gate past its clock reminds once; a ticket left at an intake gate past `sla.archive` is archived.
      const gated = tasks.filter((task) => WAITING_ON_USER.has(task.state));
      const clocks = await slaClocks.forAll(gated);
      const rows: SlaRow[] = [];
      for (const task of gated) {
        const sla = clocks.get(task.id) ?? null;
        const policy = await pipeline.policyFor(task.repoPath);
        const targets = policy.sla;
        // The diagram's `triage.sla.archive_days` (five) when the repo's sla block says nothing; 0 turns it off.
        const defaultArchive = policy.factory.triage.sla.archive_days > 0 ? policy.factory.triage.sla.archive_days * 86_400 : null;
        const archiving = AUTO_ARCHIVE_GATES.has(task.state) && (targets.archive !== undefined ? typeof targets.archive === "number" : defaultArchive !== null);
        // The plan gate also escalates to a person after the diagram's `plan.sla.escalate_days` (five); 0 turns it off.
        const escalateAfter = task.state === "awaiting_approval" && policy.factory.plan.sla.escalate_days > 0 ? policy.factory.plan.sla.escalate_days * 86_400 : null;
        if (!sla?.gate?.overdue && !archiving && escalateAfter === null) continue;
        const events = await pipeline.events(task.id);
        const latest = (kind: string) => {
          const found = events.filter((event) => event.kind === kind);
          return found.length ? new Date(Math.max(...found.map((event) => event.at.getTime()))) : null;
        };
        // Who the escalation names comes from CODEOWNERS (the gate's `ruleOwners`), never from the code map's own `owners`.
        const ruleOwners = escalateAfter === null ? undefined : ((await pipeline.approvals(task.id)).find((a) => a.decision === null)?.requested.ruleOwners as { state?: unknown; owners?: unknown } | undefined);
        const owners = ruleOwners?.state === "ok" ? ruleOwners.owners : [];
        rows.push({ task, sla, targets, defaultArchive, escalateAfter, lastReminderAt: latest("sla.reminder"), lastEscalationAt: latest("sla.escalated"), escalateTo: Array.isArray(owners) ? owners.map(String) : [] });
      }
      await applySlaActions(rows, new Date(), { record: (id, kind, payload) => pipeline.record(id, kind, payload), archive: (id, reason) => pipeline.archive(id, reason, { onlyFrom: AUTO_ARCHIVE_GATES }) });
    })
    .catch((error: unknown) => console.warn("sla tick failed", error));
}, MINUTE_MS);
slaTicker.start();

async function shutdown(): Promise<void> {
  intake?.stop();
  jiraWatch?.stop();
  jiraIntake?.stop();
  slaTicker.stop();
  graphTicker?.stop();
  pulls.stop();
  slackInbox.stop();
  socket?.stop();
  if (digestTimer) clearTimeout(digestTimer);
  pipeline.stopSupervisor();
  server.close();
  await pipeline.shutdown();
  await telemetry.flush();
  await db.destroy();
  process.exit(0);
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
