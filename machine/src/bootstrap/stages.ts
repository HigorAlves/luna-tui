// Wires up which StageRunner serves which TaskState: the real agent packs (when a
// credential and the runner image are available), the host-only runners that always run
// for real, and the stub fallback.
import type { EvidencePack, ShipContext, TaskRoute, TaskState } from "@hardness/contracts";

import type { CoverageSummary, Ledger, RunSummary } from "@hardness/contracts";

import type { Config } from "../config.ts";
import { type Credentials, machineCredentials, removeStaleCodexTemps } from "../adapters/credentials/index.ts";
import { EvidenceStore } from "../application/evidence-store.ts";
import { publishEvidence } from "../application/evidence-publish.ts";
import type { Graph } from "../application/graph.ts";
import type { Watcher } from "../application/ports.ts";
import type { TruthSink } from "../application/decision-truth.ts";
import type { Decide } from "../application/stages/check-decide.ts";
import { type AgentDeps, type AgentExtra, agentRunners, runAgent } from "../application/stages/pack-runner.ts";
import { ciWatchRunner } from "../application/stages/ci.ts";
import { e2eRunner, missingQaImageRunner } from "../application/stages/e2e.ts";
import { type EvidenceDeps, type EvidenceStageDeps, evidenceStage } from "../application/stages/evidence.ts";
import { type RetroFacts, memoryReviewRunner, withMemoryReview } from "../application/stages/memory.ts";
import type { StageContext, StageResult, StageRunner } from "../application/ports.ts";
import { type PlanDeps, planStage } from "../application/stages/plan.ts";
import { type TriageSignalDeps, withTriageSignals } from "../application/stages/triage-signals.ts";
import { prAddressRunner } from "../application/stages/pr-address.ts";
import { prReviewRunner } from "../application/stages/pr-review.ts";
import { videoPipeline } from "../application/stages/video.ts";
import { setupRunner } from "../application/stages/setup.ts";
import { shipRunnerWith } from "../application/stages/ship.ts";
import { type ShipDecide } from "../application/stages/ship-fixes.ts";
import { shipMonitor } from "../application/stages/ship-monitor.ts";
import { verifyRunner } from "../application/stages/verify.ts";
import { loadCredential } from "../adapters/credentials/claude.ts";
import { imageExists, removeLeftoverContainers, runSandbox, sandboxExecutor } from "../adapters/docker/docker.ts";
import { PackRuns, type PackRunsDeps } from "../application/pack-runs.ts";
import { PolicyStore } from "../application/policy.ts";
import { HOST_GIT, commitAll, discardPending, findCommitBySubject, headCommit, stagePending } from "../adapters/git/worktree.ts";
import { judgeRedCheck } from "../application/stages/build-watch.ts";
import { buildTestsStep } from "../application/stages/build-tests.ts";
import { exec } from "../adapters/process/exec.ts";
import { type GitHub, noTokenGitHub } from "../application/github.ts";

export interface RealStagesResult {
  real: Partial<Record<TaskState, StageRunner>>;
  /** The verifying stage's review pack, or null when agents are off; `main.ts` passes this
   *  straight into `verifyRunner({ runPack: verifyPack, ... })`. */
  verifyPack: ((context: StageContext, extra?: { blastRadius?: string[]; coverage?: CoverageSummary }) => Promise<StageResult>) | null;
  /** Runs a project's checks inside the runner image; null when stages are stubs. */
  checksExec: ReturnType<typeof sandboxExecutor> | null;
  /** What any pack run outside the pipeline needs (the Slack inbox's triage, Jira intake): the image,
   *  the credentials, the state dir, the worktrees dir and each repo's luna.yaml; null when agents are off or something is missing. */
  agentDeps: { image: string; credentials: Credentials; stateDir: string; worktreesDir: string; policies: PolicyStore } | null;
}

/** Real agents for Triage and Implementer when everything they need is there; stubs otherwise. */
/** What the retro reads about a task: the last implementing ledger and every earlier run. */
export type TaskHistory = (taskId: string) => Promise<{ ledger: Ledger | null; runs: RunSummary[] }>;

export async function buildRealStages(
  config: Config,
  watcher: Watcher,
  latestE2e: EvidenceDeps["latestE2e"],
  policies: PolicyStore = new PolicyStore(),
  history?: TaskHistory,
  github: GitHub = noTokenGitHub(),
  /** Each engine's credential, gated by what the machine holds back; defaults to the credentials alone. */
  engineCredentials: Credentials = machineCredentials(),
  /** Triage's first read of a ticket with no signals; `classify` is bound late, once PackRuns exists. */
  triageSignals?: TriageSignalDeps,
  /** The plan stage's decisions (coverage, plan check, risk): `decide` is bound late, once PackRuns exists; null runs the stage without them. */
  planDecisions?: { decide: PlanDeps["decide"] },
  /** The machine's code graphs, mounted read-only in every stage; `ensure` asks for a first build of a repo with none. */
  graphs?: { graph: Graph; ensure: (repoPath: string) => void },
  /** Build's checks (red_check, scope_check): `decide` is bound late, once PackRuns exists; null runs Build without them. */
  buildDecisions?: { decide: Decide | null },
  /** Verify's decisions (finding_classify, e2e_failure_cause), bound late like the others; null runs e2e without the failure cause. */
  verifyDecisions?: { decide: Decide | null },
  /** Evidence: the task's latest stage finishes, the pack's save and the format decision (`decide` bound late, once PackRuns exists; null picks captures or text). */
  evidenceDeps: { latestFinish: EvidenceStageDeps["latestFinish"]; save: EvidenceStageDeps["save"]; load: (taskId: string) => Promise<EvidencePack | null>; decisions: { decide: EvidenceStageDeps["decideFormat"] } } = {
    latestFinish: async () => null,
    load: async () => null,
    save: async () => {},
    decisions: { decide: null },
  },
  /** Ship's review-loop decisions (event_class, comment_intent, fix_scope, evidence_valid): `decide` is bound late, once PackRuns exists; null sends every review event to a person. */
  shipDecisions: { decide: ShipDecide | null } = { decide: null },
  /** The retro's predicted-against-actual facts for a task, computed by the machine; absent, the retro runs without them and without worth_learning. */
  retroFacts?: (taskId: string) => Promise<RetroFacts | null>,
  /** Told what the stages learn about a decision after the fact (RFC 0005 wave 7); absent keeps nothing. */
  truth?: TruthSink,
  /** The board search triage's agent may ask for; absent, `card_search` answers nothing. */
  cards?: AgentDeps["cards"],
): Promise<RealStagesResult> {
  if (!config.agents) {
    console.log("agents off (MACHINE_AGENTS=off): every stage is a stub");
    return { real: {}, verifyPack: null, checksExec: null, agentDeps: null };
  }
  // Every pack defaults to a Claude engine, so without Claude's credential nothing runs for real.
  if (!(await loadCredential())) {
    console.warn("no Claude credential in ~/.config/hardness: every stage is a stub");
    return { real: {}, verifyPack: null, checksExec: null, agentDeps: null };
  }
  if (!(await imageExists(config.runnerImage))) {
    console.warn(`image ${config.runnerImage} is missing (pnpm runner:build): every stage is a stub`);
    return { real: {}, verifyPack: null, checksExec: null, agentDeps: null };
  }
  const removed = await removeLeftoverContainers();
  if (removed > 0) console.log(`removed ${removed} leftover stage container(s)`);
  // A machine that died mid-write-back left its temp copy of the Codex login beside the real one.
  const temps = await removeStaleCodexTemps();
  if (temps > 0) console.log(`removed ${temps} stale Codex login temp file(s)`);
  const qaImage = await imageExists(config.runnerQaImage);
  if (!qaImage) {
    console.warn(`image ${config.runnerQaImage} is missing (pnpm runner-qa:build): e2e will be skipped`);
  }
  // The video image carries the narration, card, compose and measure tools; without it video degrades to captures with a note.
  const videoImage = await imageExists(config.runnerVideoImage);
  if (!videoImage) console.warn(`image ${config.runnerVideoImage} is missing (pnpm runner-video:build): Evidence will not make a video`);
  // A project's own checks run in the stage image too: what implementing installed there
  // (node_modules with Linux binaries, a Go cache) does not run on the host.
  const checksExec = sandboxExecutor(config.runnerImage);
  // Each stage gets only its own engine's credential, read when the stage starts.
  const credentials = engineCredentials;
  const deps = {
    image: config.runnerImage,
    qaImage: config.runnerQaImage,
    ...(videoImage ? { videoImage: config.runnerVideoImage } : {}),
    credentials,
    worktreesDir: config.worktreesDir,
    stateDir: config.stateDir,
    watcher,
    exec: checksExec,
    hostExec: exec,
    get decide() {
      return buildDecisions?.decide ?? null;
    },
    truth: truth ?? null,
    ...(cards ? { cards } : {}),
    policies,
    history,
    ...(graphs ? { graph: graphs.graph, ensureGraph: graphs.ensure } : {}),
  };
  const verifyPack = (context: StageContext, extra?: { blastRadius?: string[]; coverage?: CoverageSummary }) =>
    runAgent(deps, context, "verifying", { ...(extra?.blastRadius?.length ? { blastRadius: extra.blastRadius } : {}), ...(extra?.coverage ? { coverage: extra.coverage } : {}) });
  const agents = agentRunners(deps);
  const saveEvidence = (taskId: string, pack: EvidencePack) => evidenceDeps.save(taskId, { evidence: pack });
  const evidenceStore = new EvidenceStore(config.stateDir);
  /** The project's checks over what changed since `since` (a commit the machine read): luna.yaml's list, no review pack. */
  const deltaChecks = (context: StageContext, since: string) =>
    verifyRunner({
      exec: checksExec,
      runPack: null,
      stateDir: config.stateDir,
      policy: async (repoPath) => {
        const { checks, services, decisions } = await policies.for(repoPath);
        return { checks, services, decisions };
      },
      changedPaths: async (worktreePath) => {
        if (!/^[0-9a-f]{40,64}$/.test(since)) return null;
        const out = await exec("git", [...HOST_GIT, "-C", worktreePath, "diff", "--name-only", `${since}..HEAD`]);
        return out.code === 0 ? out.stdout.split("\n").map((l) => l.trim()).filter(Boolean) : null;
      },
    })(context);
  const real: Partial<Record<TaskState, StageRunner>> = {
    ...agents,
    // Build: a tests step (one failing, tagged test per scenario, committed by the machine) runs before the implementer.
    implementing: buildTestsStep({
      implement: (context, extra) => runAgent(deps, context, "implementing", extra),
      runWriter: (context, extra) => runAgent(deps, context, "build_tests", extra.plan ? { plan: extra.plan } : {}),
      judgeRed: async (check, repoPath) => {
        const policy = repoPath ? await policies.for(repoPath) : null;
        return judgeRedCheck(buildDecisions?.decide ?? null, check, repoPath, policy?.decisions ?? {});
      },
      holdout: async (repoPath) => (await policies.for(repoPath)).holdoutCases,
      git: {
        pending: stagePending,
        commit: async (path, subject, body) => {
          const sha = await commitAll(path, `${subject}\n\n${body}`);
          if (!sha) throw new Error("the tests step has nothing to commit");
          return sha;
        },
        discard: discardPending,
        findTestsCommit: findCommitBySubject,
      },
    }),
    ...(triageSignals && agents.triage ? { triage: withTriageSignals(agents.triage, triageSignals) } : {}),
    // The plan stage runs in test_design: the planner, the test designer, then three decisions, each pack a sub-run.
    test_design: planStage({
      runPack: (pack, subContext, extra) => runAgent(deps, subContext, pack, extra.plan ? { plan: extra.plan } : {}),
      get decide() {
        return planDecisions?.decide ?? null;
      },
      policies: { for: (repoPath) => policies.for(repoPath) },
      ...(graphs ? { graph: graphs.graph } : {}),
    }),
    // Setup reads the repo checkout itself (no worktree yet) and proves what it proposes in the image.
    setup: setupRunner({ runPack: (context) => runAgent(deps, context, "setup", { checkout: true }), exec: checksExec, stateDir: config.stateDir }),
    // ci_watch polls the PR's checks on the host and only calls its pack when one is red.
    ci_watch: ciWatchRunner({ github, runPack: (context, ci) => runAgent(deps, context, "ci_watch", { ci }) }),
    // e2e skips repos with no web surface; without the QA image it passes with a note.
    e2e: qaImage
      ? e2eRunner({
          runPack: (context) => runAgent(deps, context, "e2e"),
          policy: (repoPath) => policies.for(repoPath),
          get decide() {
            return verifyDecisions?.decide ?? null;
          },
          overrides: (repoPath) => policies.for(repoPath).then((p) => p.decisions),
          truth: truth ?? null,
          stateDir: config.stateDir,
        })
      : missingQaImageRunner(),
    // Evidence runs on the host from what e2e left in the state dir: it picks a format (a decision), assembles the pack and keeps its media.
    evidence: evidenceStage({
      stateDir: config.stateDir,
      latestE2e,
      latestFinish: evidenceDeps.latestFinish,
      save: evidenceDeps.save,
      truth: truth ?? null,
      get decideFormat() {
        return evidenceDeps.decisions.decide;
      },
      policies: { for: (repoPath) => policies.for(repoPath) },
      headCommit,
      videoImage: async () => videoImage,
      video: videoImage
        ? videoPipeline({
            sandbox: runSandbox,
            image: config.runnerVideoImage,
            stateDir: config.stateDir,
            runPack: (pack, subContext, extra) => runAgent(deps, subContext, pack, extra),
          })
        : null,
    }),
    // The PR tasks' own stages: the host fetches the diff or the threads, the pack answers.
    reviewing: prReviewRunner({ github, runPack: (context, review) => runAgent(deps, context, "reviewing", { review }) }),
    addressing: prAddressRunner({ github, runPack: (context, threads) => runAgent(deps, context, "addressing", { threads }) }),
    // The memory-review gate has no stage of its own: the retro pack runs after shipping and its
    // proposal rides on the gate; approving applies it at close.
    shipping: withMemoryReview(
      shipRunnerWith({
        exec,
        github,
        // Ship publishes the task's Evidence Pack once it is complete and its commit is the PR head.
        evidence: { load: evidenceDeps.load, save: saveEvidence, publish: publishEvidence, store: evidenceStore },
        // Then the PR is watched until it merges: by policy the machine merges it, else a person does.
        stateDir: config.stateDir,
        monitor: shipMonitor({
          github,
          truth: truth ?? null,
          policies,
          evidence: { load: evidenceDeps.load, save: saveEvidence, publish: publishEvidence, store: evidenceStore },
          // The review loop: the decisions bind late; the sub-runs are the same packs the stages run, on the task's own worktree.
          loop: {
            get decide() {
              return shipDecisions.decide;
            },
            runPack: (pack, subContext, extra) => {
              if (pack === "pr_reply") return runAgent(deps, subContext, "pr_reply", { ship: extra as ShipContext });
              const more = extra as { threads?: AgentExtra["threads"]; baseCommit?: string; ci?: AgentExtra["ci"] };
              return runAgent(deps, subContext, pack, { ...(more.threads ? { threads: more.threads } : {}), ...(more.baseCommit ? { baseCommit: more.baseCommit } : {}), ...(more.ci ? { ci: more.ci } : {}) });
            },
            checks: deltaChecks,
          },
          stateDir: config.stateDir,
          pollMs: config.shipPoll.intervalMs,
          maxWaitMs: config.shipPoll.maxWaitDays * 86_400_000,
        }),
      }),
      memoryReviewRunner({
        runPack: async (context, ship) => runAgent(deps, context, "reviewing_memory", { history: (await history?.(context.task.id)) ?? null, ...(ship ? { ship } : {}) }),
        stateDir: config.stateDir,
        ...(retroFacts ? { facts: retroFacts } : {}),
        // worth_learning binds late, with the other ship decisions.
        get decide() {
          return shipDecisions.decide;
        },
        overrides: async (repoPath) => (await policies.for(repoPath)).decisions.worth_learning,
      }),
    ),
  };
  return { real, verifyPack, checksExec, agentDeps: { image: config.runnerImage, credentials, stateDir: config.stateDir, worktreesDir: config.worktreesDir, policies } };
}

/** Packs on demand (`POST /runs`): on whenever agents are, off (undefined, the route's 503) only
 *  with MACHINE_AGENTS=off. Not tied to the stages' Claude credential: each call needs only its
 *  own engine's, which PackRuns checks per call (409 `no_credential` when it is missing), so a
 *  machine with only a Codex login still runs a `codex:*` pack. */
export function buildPackRuns(
  config: Pick<Config, "agents" | "runnerImage" | "stateDir">,
  deps: Omit<PackRunsDeps, "image" | "stateDir" | "credentials"> & { credentials?: Credentials },
): PackRuns | undefined {
  if (!config.agents) return undefined;
  return new PackRuns({ ...deps, image: config.runnerImage, stateDir: config.stateDir, credentials: deps.credentials ?? machineCredentials() });
}

export interface RunnerForDeps {
  real: Partial<Record<TaskState, StageRunner>>;
  realDeliverRunner: StageRunner;
  realVerifyRunner: StageRunner;
  shipRunner: StageRunner;
  stubRunnerFor: (stage: TaskState) => StageRunner;
  /** The PR routes' take on the shared stages; absent (tests) means every route runs the feature runners. */
  pr?: {
    /** `verifying` on ci_fix and address: the project's checks, never the review pack. */
    checksOnlyVerifyRunner: StageRunner;
    /** `delivering` on address: push, reply, resolve. */
    followUpRunner: StageRunner;
    /** `shipping` on review: post the verdict the gate carried. */
    postVerdictRunner: StageRunner;
  };
}

/** Delivering and verifying always run for real; shipping falls back to the stub ship
 *  runner only when the memory-review wrapper wasn't built (agents off). Everything else
 *  is whatever `buildRealStages` built, or a stub. A stage the routes share picks its
 *  runner from the task's route at run time. */
export function buildRunnerFor(deps: RunnerForDeps): (stage: TaskState) => StageRunner {
  const byRoute =
    (feature: StageRunner, pr: Partial<Record<TaskRoute, StageRunner>>): StageRunner =>
    (context) =>
      (pr[context.task.route] ?? feature)(context);
  return (stage) => {
    const pr = deps.pr;
    if (stage === "delivering") return pr ? byRoute(deps.realDeliverRunner, { address: pr.followUpRunner }) : deps.realDeliverRunner;
    if (stage === "verifying") {
      return pr ? byRoute(deps.realVerifyRunner, { ci_fix: pr.checksOnlyVerifyRunner, address: pr.checksOnlyVerifyRunner }) : deps.realVerifyRunner;
    }
    if (stage === "shipping") {
      const feature = deps.real.shipping ?? deps.shipRunner;
      return pr ? byRoute(feature, { review: pr.postVerdictRunner }) : feature;
    }
    return deps.real[stage] ?? deps.stubRunnerFor(stage);
  };
}
