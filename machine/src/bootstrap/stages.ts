// Wires up which StageRunner serves which TaskState: the real agent packs (when a
// credential and the runner image are available), the host-only runners that always run
// for real, and the stub fallback.
import type { TaskRoute, TaskState } from "@hardness/contracts";

import type { Ledger, RunSummary } from "@hardness/contracts";

import type { Config } from "../config.ts";
import { type Credentials, machineCredentials, removeStaleCodexTemps } from "../adapters/credentials/index.ts";
import type { Watcher } from "../application/ports.ts";
import { agentRunners, runAgent } from "../application/stages/pack-runner.ts";
import { ciWatchRunner } from "../application/stages/ci.ts";
import { e2eRunner, missingQaImageRunner } from "../application/stages/e2e.ts";
import { type EvidenceDeps, evidenceRunner } from "../application/stages/evidence.ts";
import { memoryReviewRunner, withMemoryReview } from "../application/stages/memory.ts";
import type { StageContext, StageResult, StageRunner } from "../application/ports.ts";
import { type TriageSignalDeps, withTriageSignals } from "../application/stages/triage-signals.ts";
import { prAddressRunner } from "../application/stages/pr-address.ts";
import { prReviewRunner } from "../application/stages/pr-review.ts";
import { setupRunner } from "../application/stages/setup.ts";
import { shipRunnerWith } from "../application/stages/ship.ts";
import { loadCredential } from "../adapters/credentials/claude.ts";
import { imageExists, removeLeftoverContainers, sandboxExecutor } from "../adapters/docker/docker.ts";
import { PackRuns, type PackRunsDeps } from "../application/pack-runs.ts";
import { PolicyStore } from "../application/policy.ts";
import { exec } from "../adapters/process/exec.ts";
import { type GitHub, noTokenGitHub } from "../application/github.ts";

export interface RealStagesResult {
  real: Partial<Record<TaskState, StageRunner>>;
  /** The verifying stage's review pack, or null when agents are off; `main.ts` passes this
   *  straight into `verifyRunner({ runPack: verifyPack, ... })`. */
  verifyPack: ((context: StageContext) => Promise<StageResult>) | null;
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
  // A project's own checks run in the stage image too: what implementing installed there
  // (node_modules with Linux binaries, a Go cache) does not run on the host.
  const checksExec = sandboxExecutor(config.runnerImage);
  // Each stage gets only its own engine's credential, read when the stage starts.
  const credentials = engineCredentials;
  const deps = {
    image: config.runnerImage,
    qaImage: config.runnerQaImage,
    credentials,
    worktreesDir: config.worktreesDir,
    stateDir: config.stateDir,
    watcher,
    exec: checksExec,
    policies,
    history,
  };
  const verifyPack = (context: StageContext) => runAgent(deps, context, "verifying");
  const agents = agentRunners(deps);
  const real: Partial<Record<TaskState, StageRunner>> = {
    ...agents,
    ...(triageSignals && agents.triage ? { triage: withTriageSignals(agents.triage, triageSignals) } : {}),
    // Setup reads the repo checkout itself (no worktree yet) and proves what it proposes in the image.
    setup: setupRunner({ runPack: (context) => runAgent(deps, context, "setup", { checkout: true }), exec: checksExec, stateDir: config.stateDir }),
    // ci_watch polls the PR's checks on the host and only calls its pack when one is red.
    ci_watch: ciWatchRunner({ github, runPack: (context, ci) => runAgent(deps, context, "ci_watch", { ci }) }),
    // e2e skips repos with no web surface; without the QA image it passes with a note.
    e2e: qaImage
      ? e2eRunner({ runPack: (context) => runAgent(deps, context, "e2e"), policy: (repoPath) => policies.for(repoPath) })
      : missingQaImageRunner(),
    // Evidence is script-only, so it runs on the host from what e2e left in the state dir.
    evidence: evidenceRunner({ stateDir: config.stateDir, latestE2e }),
    // The PR tasks' own stages: the host fetches the diff or the threads, the pack answers.
    reviewing: prReviewRunner({ github, runPack: (context, review) => runAgent(deps, context, "reviewing", { review }) }),
    addressing: prAddressRunner({ github, runPack: (context, threads) => runAgent(deps, context, "addressing", { threads }) }),
    // The memory-review gate has no stage of its own: the retro pack runs after shipping and its
    // proposal rides on the gate; approving applies it at close.
    shipping: withMemoryReview(
      shipRunnerWith({ exec, github }),
      memoryReviewRunner({
        runPack: async (context) => runAgent(deps, context, "reviewing_memory", { history: (await history?.(context.task.id)) ?? null }),
        stateDir: config.stateDir,
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
