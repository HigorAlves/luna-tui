// The stages that run as packs in a sandbox: the machine writes a StageInput, the container
// runs the factory runner, and the machine ingests what the pack left in /out.
import { AnswerScenario, AnswerStep, type CiContext, type CoverageSummary, EscalationReason, type EngineId, Ledger, PACKS, Slice, credentialOwner, type StageInput, type PackId, type PlanContext, type ReviewContext, type RunSummary, type ServiceSpec, type ShipContext, type TaskState, type ThreadsContext, type VideoContext, criteriaOf, scenariosOfAnswer, stepsOfAnswer } from "@hardness/contracts";
import { existsSync, statSync } from "node:fs";
import { z } from "zod";
import { mkdir, readFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";

import { readRegularFile } from "../../adapters/fs/bounded.ts";
import { removeNestedRepositories } from "../../adapters/git/machine-repo.ts";
import { bundleImporter } from "../../adapters/git/bundles.ts";
import type { TaskRow } from "../../domain/task.ts";
import { ensureClone, isClone, moveToClone, publishBranch, refreshScratch } from "../../adapters/git/clone.ts";
import {
  type Workspace,
  branchBase,
  commonGitDir,
  gitIdentity,
  diffNameStatus,
  diffText,
  headCommit,
  lockfilesAt,
  repoHead,
  defaultBranch,
  onDefaultBranch,
  dirtyFiles,
  ownedWorkspace,
  readCommitDiff,
  resetWorktree,
  restoreFiles,
  stackOf,
} from "../../adapters/git/worktree.ts";
import { CredentialWaitError, type CredentialMount, type Credentials, NoCredentialError } from "../../adapters/credentials/index.ts";
import { type SandboxResult, type SandboxRun, SecretsMissingError, cacheVolumeFor, runSandbox } from "../../adapters/docker/docker.ts";
import { EgressUnsupportedError } from "../../adapters/docker/egress.ts";
import { type EgressPolicy, blockedPayloads } from "../egress-policy.ts";
import type { InstallInput, InstallOutcome } from "../install.ts";
import type { SecretStore } from "../secrets.ts";
import { redactDeep, secretRedactor } from "../../domain/redact-secrets.ts";
import { redactFiles } from "../../adapters/fs/redact-files.ts";
import { saveKept } from "../kept-sandboxes.ts";
import { LOCKFILES, envOf } from "../../domain/env-hash.ts";
import { safe } from "../../domain/evidence-markdown.ts";
import { type DetectedChecks, detectChecks } from "../../domain/detect.ts";
import { PROTECTED_BRANCHES, branchLinkOf } from "../../domain/jira-link.ts";
import { lockedFilesRemoved, lockedFilesTouched } from "../../domain/locked-files.ts";
import { type ScopeIssue, scopeIssues } from "../../domain/scope.ts";
import { diffSummaryOf } from "../../domain/diff-summary.ts";
import { StuckDetector } from "../../domain/stuck.ts";
import { type ExecResult, exec } from "../../adapters/process/exec.ts";
import { checkpointPush } from "./checkpoint.ts";
import { readScenarioReds } from "./scenario-reds.ts";

import type { TruthSink } from "../decision-truth.ts";
import { type Decide, buildChecks, buildWatch, cardSearchAnswers } from "./build-watch.ts";
import { type CardHit, sourceKindOf } from "../../domain/card-search.ts";
import { ingestStageOutput, toStageResult } from "./ingest.ts";
import { prepareStageCredentials } from "./stage-credentials.ts";
import { PACK_LIMITS, buildStageInput } from "../../domain/stage-input.ts";
import { reviewerEngine } from "../../domain/engine-choice.ts";
import { pickEngine } from "../engine.ts";
import type { Graph } from "../graph.ts";
import { PolicyStore } from "../policy.ts";
import { RepoImageError } from "../repo-images.ts";
import { type GraphReadiness, graphEscalation, graphSkipped } from "../graph-ready.ts";
import type { StageContext, StageResult, StageRunner, Watcher } from "../ports.ts";

export interface AgentDeps {
  /** The id of a local image, for the environment hash; absent, no environment is recorded. */
  imageId?: (image: string) => Promise<string>;
  /** The base stage image. */
  image: string;
  /** Resolves the image a repository's stages run in (its own, built from its base, or `image`); absent, every repository runs in `image`. */
  repoImages?: { ensure(repoPath: string, signal?: AbortSignal, taskId?: string): Promise<{ image: string }> };
  /** The image with browsers, used by the e2e pack. */
  qaImage: string;
  /** The image with the video tools, used by the recording pack; absent falls back to the QA image. */
  videoImage?: string;
  /** Each engine's credential; a stage gets only its own engine's. */
  credentials: Credentials;
  worktreesDir: string;
  stateDir: string;
  watcher: Watcher;
  /** Replaces the docker sandbox; tests pass a fake. */
  sandbox?: (run: SandboxRun) => Promise<SandboxResult>;
  /** The list of hosts each run may reach; absent (`MACHINE_EGRESS=off`, tests) a run joins an ordinary bridge as before the allow-list. */
  egress?: EgressPolicy;
  /** Installs the card's dependencies from its lockfile before a writable stage (application/install.ts); absent, nothing is installed by the machine. */
  install?: (input: InstallInput) => Promise<InstallOutcome>;
  /** The owner's store of a repository's scoped secrets; only the browser runs read it, for their QA target's credential. */
  secrets?: SecretStore;
  /** Finds the project's own check commands; the locked-test replay runs the test one. */
  detect?: (worktreePath: string) => Promise<DetectedChecks>;
  /** Each repo's luna.yaml; one store is shared so a bad edit warns once. */
  policies?: PolicyStore;
  /** The task's record (last implementing ledger, every run): implementing resumes its ledger from it, the retro reads it. */
  history?: (taskId: string) => Promise<{ ledger: Ledger | null; runs: RunSummary[] }>;
  /** The machine's code graphs: a repo's current one is mounted read-only at /graph in every stage. */
  graph?: Graph;
  /** Asked for when a repo has no graph yet, so the first build starts without a stage waiting on it. */
  ensureGraph?: (repoPath: string) => void;
  /** Waits for the repository's code graph before triage reads it (see plan.ts); absent, triage never waits. */
  graphReady?: (input: { repoPath: string; signal: AbortSignal; skip: boolean; note?: (text: string) => Promise<void> }) => Promise<GraphReadiness>;
  /** What a stacked card's workspace is cut from, asked once when the workspace is first made (built from the dependency rule over the rows as they are now): the parent's branch, "merged" (cut from the default branch and drop the card's base), "gone" (the run fails with the reason), or null for a card with no base. */
  baseFor?: (task: TaskRow) => Promise<{ state: "open"; branch: string } | { state: "merged" } | { state: "gone"; reason: string } | null>;
  /** Drops a card's `card.base` (the pipeline's `clearBase`). */
  clearBase?: (taskId: string) => Promise<void>;
  /** Runs a host command; the locked-test replay uses it for the project's test command. */
  exec?: (
    command: string,
    args: string[],
    options: { env?: NodeJS.ProcessEnv; cwd?: string; signal?: AbortSignal; timeoutMs?: number; services?: Record<string, ServiceSpec>; repoPath?: string },
  ) => Promise<ExecResult>;
  /** Runs a command on the host (not in the stage image): the build watch pushes the task branch with it. */
  hostExec?: (command: string, args: string[], options?: { cwd?: string; signal?: AbortSignal; timeoutMs?: number }) => Promise<ExecResult>;
  /** Runs a decision pack on a check context (red_check, scope_check) for the build watch; null runs Build without the checks. Read at call time: main.ts binds it late. */
  decide?: Decide | null;
  /** Told what the stages learn about a decision after the fact (RFC 0005 wave 7); absent keeps nothing. */
  truth?: TruthSink | null;
  /** How often the build watch looks at the run's ledger, in ms. */
  watchEvery?: number;
  /** Replaces the git reads the scope check makes (tests). */
  scopeGit?: { nameStatus(from: string, to: string): Promise<string>; diff(from: string, to: string): Promise<string> };
  /** Replaces the wait between checkpoint push tries (tests). */
  pushSleep?: (ms: number) => Promise<void>;
  /** The board search triage's agent asks for (`card_search`): read-only, the task's own repository only. Absent: the tool answers nothing. */
  cards?: { search(request: { repoPath: string | null; selfId: string; selfSource: string | null; query: string }): Promise<CardHit[]> };
}

/** Every branch the pipeline writes starts with this; see `workspaceFor`. */
const TASK_BRANCH_PREFIX = "task/";

/** How long the original tests may take when replayed against a changed test file. */
const LOCKED_REPLAY_TIMEOUT_MS = 10 * 60_000;

const MINUTE = 60_000;
/** Where a repo's graph is mounted in a stage container, and the file the `graphify` verbs read. */
const GRAPH_MOUNT = "/graph";
const GRAPH_FILE = "/graph/graphify-out/graph.json";
const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

export interface AgentExtra {
  /** ci_watch: what the host fetched about the PR's CI, since the sandbox has no GitHub credential. */
  ci?: CiContext | null;
  /** reviewing: the PR's diff, files and comments, fetched by the host. */
  review?: ReviewContext | null;
  /** addressing: the PR's unresolved threads, fetched by the host. */
  threads?: ThreadsContext | null;
  /** reviewing_memory: the last implementing ledger and every earlier run, from the machine's records. */
  history?: { ledger: Ledger | null; runs: RunSummary[] } | null;
  /** setup: run over the repo checkout itself, read-only, no task worktree or branch. */
  checkout?: boolean;
  /** The plan stage's packs: the plan under review (the test designer reads it as its plan; a second round carries the gaps or the review). */
  plan?: PlanContext;
  /** verifying: the files the code graph says depend on what the change touched. */
  blastRadius?: string[];
  /** verifying: the coverage of the change's added lines. */
  coverage?: CoverageSummary;
  /** verifying: the image the stage chose once (it compared the environment against it); the sandbox runs in it and the repository's image is not resolved again. */
  image?: string;
  /** The video packs: the scenarios, target, narration and measurements. */
  video?: VideoContext | null;
  /** verifying after a shipped PR's fix: the commit to diff against, over the branch's fork point (only the delta is reviewed). */
  baseCommit?: string;
  /** pr_reply: the thread and the pack, built by the host; a reviewer's text only ever rides here. */
  ship?: ShipContext;
  /** implementing: every path of the tests commit, protected from change. */
  testsFiles?: string[];
  /** implementing: the source files that hold Rust's inline tests, which the implementer may change. */
  inlineTests?: string[];
  /** implementing, feature route: the commit the scope is measured from (the tests commit the machine made); absent, the branch's base. */
  scopeBase?: string;
  /** implementing: the tests Build's tests step made, one per scenario. */
  scenarioTests?: { scenario: string; file: string }[];
  /** implementing, after a failed regression sweep: the failing checks and their output tails. */
  sweepFailures?: { name: string; tail: string }[];
  /** Extra mounts for the container, after the worktree's own (the critic's /evidence, read-only). */
  mounts?: CredentialMount[];
  /** e2e: the one target the browser run is given, chosen by the machine (the app it started, a preview); absent, the repository's first declared QA target, or none. Only its credential is loaded. */
  qaTarget?: { name: string; baseUrl: string; credential?: string | null; reentrant?: boolean } | null;
  /** e2e: more networks the run joins (the app's), and the names it reaches directly instead of through its proxy. */
  alsoJoin?: string[];
  noProxy?: string[];
  /** e2e: secret values of the app, the seed or the deploy, which the browser run never holds: used only to clean what its output and files carry. */
  redactValues?: Record<string, string>;
}

/** `host:port` of each QA target's URL, for the browser run's list (an address or a private name is dropped later, by the list's own rules). */
function targetHosts(targets: ReadonlyArray<{ baseUrl: string }>): string[] {
  return targets.flatMap((target) => {
    try {
      const url = new URL(target.baseUrl);
      return [`${url.hostname}:${url.port || (url.protocol === "https:" ? "443" : "80")}`];
    } catch {
      return [];
    }
  });
}

/** The files the plan's slices touch, with the code map's files to change or test when it has one (a file only to read is not planned). */
function plannedFiles(plan: StageInput["plan"]): string[] {
  const touched = (plan?.slices ?? []).flatMap((slice) => {
    const parsed = Slice.safeParse(slice);
    return parsed.success ? parsed.data.touchpoints : [];
  });
  return [...new Set([...touched, ...(plan?.map?.files ?? []).filter((f) => f.role !== "read").map((f) => f.path)])];
}

const SCOPE_TITLES: Record<ScopeIssue["kind"], string> = {
  undeclared_file: "file outside the plan, not declared",
  test_removed: "test removed",
  switched_off_test: "test switched off in place",
  test_weakened: "scenario test changed after the tests commit",
  secret: "secret-looking addition",
  new_dependency: "dependency the plan did not name",
  unrelated_refactor: "unrelated refactor",
  todo: "TODO left in place",
};
const SCOPE_ADVICE: Partial<Record<ScopeIssue["kind"], string>> = {
  undeclared_file: "The plan's slices and the code map do not name this file and the answer did not declare it. Revert it, or declare it in outOfMap with the reason the slice needs it.",
  test_removed: "The change removes this test; restore it.",
  switched_off_test: "A test was switched off in place (skip, only, ignore, disabled). Turn it back on and fix the code instead.",
  test_weakened: "A scenario's tagged test was changed or dropped after the tests commit. Restore it and make it pass.",
  secret: "The change adds something that looks like a secret. Remove it.",
};

const OutOfMap = z.array(z.object({ path: z.string(), reason: z.string() }));

export async function runAgent(deps: AgentDeps, context: StageContext, pack: PackId, extra: AgentExtra = {}): Promise<StageResult> {
  // The image the stage's sandbox runs in is chosen once, inside the run, and carried out here: the record of Build's environment names it, never a second resolution.
  const chosen: { image?: string } = {};
  const result = await runAgentIn(deps, context, pack, extra, chosen);
  // The environment a passing Build ran in: the run's own record, and the Build Report's `envHash`.
  const path = result.workspace?.worktreePath;
  if (pack !== "implementing" || result.outcome !== "pass" || !path || !deps.imageId) return result;
  try {
    const commit = await headCommit(path);
    return { ...result, detail: { ...result.detail, env: envOf({ image: await deps.imageId(chosen.image ?? deps.image), lockfiles: await lockfilesAt(path, commit, LOCKFILES), commit }) } };
  } catch (error) {
    console.warn(`could not record the Build's environment: ${(error as Error).message}`);
    return result;
  }
}

async function runAgentIn(deps: AgentDeps, context: StageContext, pack: PackId, extra: AgentExtra = {}, chosen: { image?: string } = {}): Promise<StageResult> {
  const { task } = context;
  if (!task.repoPath) {
    throw new Error("the task has no repoPath; create it with a repo to run real stages");
  }
  const limits = PACK_LIMITS[pack];
  if (extra.checkout && limits.writable) throw new Error(`${pack} is writable; a checkout run must be read-only`);
  const policy = await (deps.policies ?? sharedPolicies).for(task.repoPath);
  // The repository's own image, built from the base its luna.yaml names; a build that fails is an environment problem with the reason.
  let stageImage = extra.image ?? deps.image;
  if (deps.repoImages && !extra.checkout && !extra.image) {
    try {
      stageImage = (await deps.repoImages.ensure(task.repoPath, context.signal, task.id)).image;
    } catch (error) {
      if (!(error instanceof RepoImageError)) throw error;
      return { outcome: "escalated", detail: { escalation: "env_broken", envBroken: true, step: "image", reason: `the repository's image could not be built: ${error.reason}`, options: ["fix sandbox.image.base in luna.yaml, or remove it to use the machine's image, then resume"] } };
    }
  }
  chosen.image = stageImage;
  if (pack === "triage" && deps.graphReady) {
    const ready = await deps.graphReady({ repoPath: task.repoPath, signal: context.signal, skip: graphSkipped(context.approvals), ...(context.note ? { note: context.note } : {}) });
    if (ready.state === "failed") return graphEscalation(ready.reason);
  }
  // The branch the pipeline would give this task today: `task/<id>-<slug>`, or the repo's
  // `jira.branch` pattern for a linked task (with the id appended when the repo already has
  // that branch). A task that already works somewhere keeps that branch: it was named and
  // checked when the worktree was made, and the link cannot change while the worktree exists,
  // so a later issue-type change in Jira does not rename what is already pushed.
  const owned = await ownedWorkspace(task, task.repoPath, deps.worktreesDir, policy.jira?.branch);
  const persisted = Boolean(task.branch && task.worktreePath) && !extra.checkout;
  const workspace: Workspace = extra.checkout ? { branch: "", path: task.repoPath } : persisted ? { branch: task.branch!, path: task.worktreePath! } : owned;
  // The branch is a structural gate: whatever a task row says, a writable stage only ever
  // commits to a branch the pipeline owns: a `task/` branch, the one it named for a linked
  // task (the branch it persisted carries the issue key or the task id, never a protected
  // name), or, for a PR task, the PR's own head branch.
  const prBranch = task.source?.kind === "github_pr" ? task.source.headRef : null;
  const link = branchLinkOf(task);
  const ownsPersisted = (branch: string): boolean => persisted && link !== null && (branch.includes(link.key) || branch.includes(task.id.slice(0, 8)));
  const protectedBranch = limits.writable && !extra.checkout && (PROTECTED_BRANCHES.has(workspace.branch) || workspace.branch === (await defaultBranch(task.repoPath)));
  if (
    limits.writable &&
    (protectedBranch || (!workspace.branch.startsWith(TASK_BRANCH_PREFIX) && workspace.branch !== prBranch && workspace.branch !== owned.branch && !ownsPersisted(workspace.branch)))
  ) {
    return {
      outcome: "fail",
      detail: { error: `refusing to run ${pack} on branch ${workspace.branch}: the pipeline only writes ${TASK_BRANCH_PREFIX}* branches (or the branch it named for a Jira-linked task)` },
    };
  }
  // A folder that is neither a card's workspace nor a linked worktree of the repository (its own main checkout) is nobody's to run in.
  if (!extra.checkout && persisted && !isClone(workspace.path) && !isFile(join(workspace.path, ".git")) && existsSync(workspace.path)) {
    return { outcome: "fail", detail: { error: `refusing to run ${pack} in ${workspace.path}: it is not a card's workspace` } };
  }
  // A card still on a linked worktree moves to a workspace of its own before its next run: branch and commits kept, uncommitted work carried over.
  if (!extra.checkout && persisted && !isClone(workspace.path)) await moveToClone(task.repoPath, workspace);
  let stackedOn: { branch: string } | undefined;
  if (!extra.checkout && deps.baseFor && !isClone(workspace.path)) {
    const answer = await deps.baseFor(task);
    if (answer?.state === "gone") return { outcome: "fail", detail: { error: answer.reason } };
    if (answer?.state === "open") stackedOn = { branch: answer.branch };
    else if (answer?.state === "merged") await deps.clearBase?.(task.id);
  }
  if (!extra.checkout) {
    try {
      await ensureClone(task.repoPath, workspace, stackedOn);
    } catch (error) {
      // A parent branch that is not on origin, or a tip that is no commit: the card waits for a person with the reason; no workspace is left.
      if (!stackedOn) throw error;
      return { outcome: "fail", detail: { error: `the card could not be started on its parent's branch ${stackedOn.branch}: ${(error as Error).message.slice(0, 300)}` } };
    }
  }
  // After a restart, the container the last machine started may still be running: its name and
  // the commit it started from come from the run row, and the sandbox waits on it instead.
  const resume = context.resume;
  const inputCommit = resume?.inputCommit ?? (await (extra.checkout ? repoHead(workspace.path) : headCommit(workspace.path)));
  // A card's workspace is a folder: its repository is the machine's and is never mounted. Only a checkout run reads the user's
  // repository directly, through its git dir, read-only.
  const gitDir = extra.checkout ? await commonGitDir(task.repoPath) : null;
  // A pack the state is not named for (the planner in test_design) names its container after itself.
  const unit = pack === context.stage ? context.stage : pack;
  const container = resume?.container ?? `hardness-${task.id.slice(0, 8)}-${unit.replaceAll("_", "-")}-${context.attempt}`;
  const runDir = join(deps.stateDir, "runs", context.runId);
  // The task's own engine for the pack, else luna.yaml's, else the default; a re-attached run
  // keeps the engine its container started on, and a fallback after a usage limit runs the engine
  // the machine handed it (which logs why). An engine passed over is logged with why.
  let choice: { engine: EngineId; reason: string | null; note?: string } = resume?.engine
    ? { engine: resume.engine, reason: null }
    : context.engine
      ? { engine: context.engine, reason: null }
      : await pickEngine(deps.credentials, PACKS[pack], task.stages ?? null, policy.engines, task.repoPath);
  // The reviewer is another model family than the implementer when that family's credential is on the machine and nobody named an engine for it.
  if (pack === "verifying" && !resume?.engine && !context.engine && "source" in choice && choice.source === "default") {
    const implementer = task.stages?.implementing ?? policy.engines?.implementing ?? PACKS.implementing.engines.default;
    const ready = new Set<EngineId>();
    for (const engine of PACKS.verifying.engines.allowed) if ((await deps.credentials.check(engine, { repo: task.repoPath })).available) ready.add(engine);
    const other = reviewerEngine(PACKS.verifying, implementer, (e) => ready.has(e));
    if (other) choice = { engine: other.engine, reason: other.reason };
  }
  const engineEvents = choice.reason ? [{ at: new Date().toISOString(), kind: "engine", payload: { pack, engine: choice.engine, reason: choice.reason } }] : [];
  if (!resume) await context.started?.({ container, inputCommit, engine: choice.engine });
  // An engine asked for that gave way to the default is said on the task as it starts, not only in the run's events.
  if (choice.note) await context.note?.(choice.note).catch(() => {});

  // The repo's code graph, read-only at /graph, with how current it is against where this task forked.
  const baseCommit = extra.baseCommit ?? (await (extra.checkout ? repoHead(workspace.path) : branchBase(workspace.path, task.repoPath)));
  const graphStamp = deps.graph && policy.graph ? await deps.graph.stampOf(task.repoPath) : null;
  const graphDir = graphStamp ? deps.graph!.currentDir(task.repoPath) : null;
  if (deps.graph && policy.graph && !graphDir) deps.ensureGraph?.(task.repoPath);
  const graphContext =
    graphStamp && graphDir
      ? { path: GRAPH_FILE, commit: graphStamp.commit, builtAt: graphStamp.builtAt, fresh: baseCommit ? await deps.graph!.isFresh(task.repoPath, graphStamp, baseCommit) : true }
      : null;

  // The browser run drives ONE target, chosen here, and holds only that target's credential.
  const e2eTarget = pack === "e2e" ? (extra.qaTarget !== undefined ? extra.qaTarget : (policy.qaTargets[0] ?? null)) : null;
  // Verify is told which files the machine's own tests commit added, so a "which files change" criterion is judged without them.
  const testsRead = pack === "verifying" && context.testsCommit ? await readCommitDiff(workspace.path, context.testsCommit).catch(() => null) : null;
  const testsCommit = testsRead
    ? { sha: context.testsCommit!, files: testsRead.nameStatus.split("\n").map((l) => l.split("\t")).filter(([status = ""]) => /^[AMCR]/.test(status)).map((cols) => cols[cols.length - 1] ?? "").filter(Boolean) }
    : null;
  const input = buildStageInput({
    task: { ...task, branch: workspace.branch },
    stage: context.stage,
    pack,
    ...(extra.plan ? { plan: extra.plan } : {}),
    engine: choice.engine,
    attempt: context.attempt,
    approvals: context.approvals,
    priorFindings: pack === "implementing" ? (context.priorFindings ?? []) : [],
    baseCommit,
    ...(testsCommit ? { testsCommit } : {}),
    graph: graphContext,
    ci: extra.ci ?? null,
    review: extra.review ?? null,
    threads: extra.threads ?? null,
    ...(extra.ship ? { ship: extra.ship } : {}),
    ...(extra.blastRadius?.length ? { blastRadius: extra.blastRadius } : {}),
    ...(extra.coverage ? { coverage: extra.coverage } : {}),
    holdoutCases: policy.holdoutCases,
    ...(context.budgetMinutes !== undefined ? { budgetMinutes: context.budgetMinutes } : {}),
    ...(extra.scenarioTests?.length ? { scenarioTests: extra.scenarioTests } : {}),
    ...(extra.sweepFailures?.length ? { sweepFailures: extra.sweepFailures } : {}),
    // The recorder drives the one target the film is recorded against; the e2e pack picks from the repo's list.
    qaTargets: pack === "recording" ? (extra.video?.target ? [extra.video.target] : []) : pack === "e2e" ? (e2eTarget ? [e2eTarget] : []) : policy.qaTargets,
    ...(extra.video ? { video: extra.video } : {}),
    checks: policy.checks,
    history: extra.history ?? ((pack === "implementing" || pack === "reviewing_memory") && deps.history ? await deps.history(task.id) : null),
  });

  // Watches the transcript as it streams: a loop on one call is stopped before it spends the turn budget.
  const detector = new StuckDetector();
  // The SDK's session transcripts live per task on the host: a session outlives the attempt,
  // you can read it, and a later run can resume it.
  const sessionMount = join(deps.stateDir, "tasks", task.id, "session");
  await mkdir(sessionMount, { recursive: true });
  // Only this engine's credential, and its helpers' on other engines (delegated inside the
  // container), prepared under the run folder and released once the container is gone. One only
  // one run may hold at a time (the Codex login) is waited for within the stage's own timeout, and
  // the wait is said on the task, not left a silent hang.
  let credential;
  try {
    const note = (line: string) => void context.note?.(line).catch(() => {});
    credential = await prepareStageCredentials(deps.credentials, PACKS[pack], choice.engine, runDir, {
      signal: context.signal,
      timeoutMs: input.limits.timeoutMs,
      onWait: note,
      repo: task.repoPath,
      note,
    });
  } catch (error) {
    if (!(error instanceof NoCredentialError || error instanceof CredentialWaitError)) throw error;
    return { outcome: "fail", detail: { error: error.message }, ...(engineEvents.length ? { events: engineEvents } : {}) };
  }
  // What the run commits comes back as bundles in /out/bundles, read like a fetch from an untrusted server: the host never reads the agent's own repository.
  const importer = extra.checkout
    ? null
    : bundleImporter({
        path: workspace.path,
        branch: workspace.branch,
        runId: context.runId,
        dir: join(runDir, "out", "bundles"),
        // The card's branch shows in the user's repository too, written by the machine; a refusal is a note.
        onAccepted: async () => {
          const shown = await publishBranch(task.repoPath!, workspace.path, workspace.branch);
          if (!shown.ok) await context.note?.(shown.note).catch(() => {});
        },
      });
  // Implementing: every slice that turns committed is pushed as it lands, one push at a time.
  const pushes = { attempted: 0, ok: 0 };
  let lastPushed: string | null = null;
  const pushErrors: string[] = [];
  let watch: ReturnType<typeof buildWatch> | null = null;
  let pushing: Promise<void> = Promise.resolve();
  // The machine's side of the checks the implementer asks for: a red slice and the change's scope.
  const checks =
    pack === "implementing" && !extra.checkout
      ? buildChecks({
          outDir: join(runDir, "out"),
          repoPath: task.repoPath,
          worktree: workspace.path,
          // The feature route measures the scope over the card's whole change, so a fix run that changes nothing still sees what an earlier run committed: from the vetted tests commit, else the commit the card's first implementing run started from (the machine's own stage_runs row; the first run's own start, read by the host before the container ran). Never from a ref or a later run's commit: with none of them the check fails closed. A route with no plan keeps the run's own commit.
          inputCommit: input.plan != null ? (extra.scopeBase ?? context.firstInputCommit ?? (context.attempt === 1 ? inputCommit : null)) : inputCommit,
          slices: input.plan?.slices ?? [],
          planned: plannedFiles(input.plan),
          planPresent: input.plan != null,
          ...(extra.scenarioTests?.length ? { scenarioTests: extra.scenarioTests } : {}),
          ...(extra.testsFiles?.length ? { protectedPaths: extra.testsFiles } : {}),
          ...(extra.inlineTests?.length ? { inlineTests: extra.inlineTests } : {}),
          ...(task.repoPath ? { repoFiles: (paths: string[]) => onDefaultBranch(task.repoPath!, paths) } : {}),
          get decide() {
            return deps.decide ?? null;
          },
          overrides: policy.decisions,
          truth: deps.truth ?? null,
          taskId: task.id,
          git: deps.scopeGit ?? { nameStatus: async (from, to) => (await importer?.sync(), diffNameStatus(workspace.path, from, to)), diff: async (from, to) => (await importer?.sync(), diffText(workspace.path, from, to)) },
          log: (line) => void context.note?.(line).catch(() => {}),
        })
      : null;
  // Triage's board search: the same mailbox, answered over this task's own repository only.
  const cardSearch =
    pack === "triage" && deps.cards
      ? cardSearchAnswers({ outDir: join(runDir, "out"), search: (query) => deps.cards!.search({ repoPath: task.repoPath, selfId: task.id, selfSource: sourceKindOf(task), query }) })
      : null;
  const startWatch = (): void => {
    if ((!checks && !cardSearch) || watch) return;
    const hostExec = deps.hostExec;
    watch = buildWatch({
      outDir: join(runDir, "out"),
      every: deps.watchEvery ?? 2000,
      log: (line) => void context.note?.(line).catch(() => {}),
      ...(checks ? { onRed: async (...a: Parameters<typeof checks.onRed>) => (await importer?.sync(), checks.onRed(...a)), onScopeRequest: async (...a: Parameters<typeof checks.onScopeRequest>) => (await importer?.sync(), checks.onScopeRequest(...a)) } : {}),
      ...(cardSearch ? { onCardSearch: cardSearch.onCardSearch } : {}),
      onCommitted: async (slice) => {
        if (!checks) return;
        await importer?.sync();
        await checks.onGreen(slice).catch((error: Error) => void context.note?.(`red_check truth: ${error.message}`).catch(() => {}));
        if (!hostExec) return;
        pushing = pushing.then(async () => {
          // One push per tip: two slices committed on the same HEAD need one checkpoint, and a tip
          // already on the remote is not pushed again.
          await importer?.sync();
          const tip = await headCommit(workspace.path).catch(() => null);
          if (tip && tip === lastPushed) return;
          pushes.attempted += 1;
          const landed = await checkpointPush({
            exec: hostExec,
            branch: workspace.branch,
            cwd: workspace.path,
            follows: "green",
            signal: context.signal,
            tip: async () => tip,
            alreadyPushed: lastPushed,
            ...(deps.pushSleep ? { sleep: deps.pushSleep } : {}),
            ...(context.emit ? { emit: context.emit } : {}),
            note: async (text) => {
              pushErrors.push(text);
              await context.note?.(`slice ${slice.id}: ${text}`).catch(() => {});
            },
          });
          if (landed) {
            pushes.ok += 1;
            lastPushed = landed;
          }
        });
        return pushing;
      },
    });
  };
  // The agent starts with a git repository of its own in the folder, made by the machine from the card's: the one the host never reads.
  if (!extra.checkout && !resume) await refreshScratch(workspace.path, workspace.branch);
  // The machine installs the card's dependencies from its lockfile, no credential in that container: the agent then works with them.
  if (deps.install && limits.writable && !extra.checkout && !resume) {
    let installed: InstallOutcome;
    try {
      installed = await deps.install({ taskId: task.id, repoPath: task.repoPath, workspace: workspace.path, commit: inputCommit, signal: context.signal });
    } catch (error) {
      credential.release();
      throw error;
    }
    for (const payload of blockedPayloads(installed.blocked, "install")) await Promise.resolve(context.emit?.("sandbox.egress_blocked", payload)).catch(() => {});
    if (!installed.ok) {
      credential.release();
      return { outcome: "escalated", detail: installed.detail };
    }
    for (const note of installed.notes) await context.note?.(note).catch(() => {});
  }
  // The one agent stage that holds a scoped secret: the browser run, the credential its QA target names (`credential: env:NAME`), by name in the
  // prompt and by value only in the container's environment. Implementing and the rest get none, whatever a check declares.
  let secretValues: Record<string, string> | undefined;
  let qaCredentialNames: string[] = [];
  if (deps.secrets && (pack === "e2e" || pack === "recording")) {
    const names = [...new Set((pack === "recording" ? (extra.video?.target ? [extra.video.target] : []) : e2eTarget ? [e2eTarget] : []).flatMap((t) => (t.credential?.startsWith("env:") ? [t.credential.slice(4)] : [])))];
    if (names.length > 0) {
      const loaded = await deps.secrets.load(task.repoPath, names);
      if (loaded.missing.length > 0) {
        credential.release();
        return { outcome: "escalated", detail: new SecretsMissingError(loaded.missing, deps.secrets.folder(task.repoPath)).detail };
      }
      secretValues = loaded.values;
      qaCredentialNames = names;
    }
  }
  // The run's own list: its engine's owner and each helper's, and for a browser run the hosts of the QA target(s) it may drive.
  const found = PACKS[pack];
  const owners = [credentialOwner(choice.engine), ...(found.kind === "decision" ? [] : found.helpers.map((h) => credentialOwner(h.engine)))];
  const egress = deps.egress
    ? await deps.egress.for({ repoPath: task.repoPath, kind: "agent", owners: [...new Set(owners)], targets: pack === "e2e" || pack === "recording" ? targetHosts(input.context.qaTargets ?? []) : [] })
    : undefined;
  let sandbox: SandboxResult;
  try {
  sandbox = await (deps.sandbox ?? runSandbox)({
    ...(egress ? { egress } : {}),
    ...(secretValues ? { secrets: secretValues } : {}),
    ...(extra.redactValues ? { redactValues: extra.redactValues } : {}),
    ...(extra.alsoJoin?.length ? { alsoJoin: extra.alsoJoin } : {}),
    ...(extra.noProxy?.length ? { noProxy: extra.noProxy } : {}),
    name: container,
    attach: Boolean(resume),
    // The verifier never sees the card's shared agent session: it reviews from the plan, the scenarios and the Build Report, not the implementer's trail.
    ...(pack === "verifying" ? {} : { sessionMount }),
    cacheVolume: cacheVolumeFor(task.repoPath),
    image: pack === "e2e" ? deps.qaImage : pack === "recording" ? (deps.videoImage ?? deps.qaImage) : stageImage,
    runDir,
    worktree: workspace.path,
    writable: limits.writable,
    gitDir,
    limits: { cpu: policy.factory.sandbox.cpu, memoryGb: policy.factory.sandbox.memory_gb },
    gitIdentity: limits.writable ? await gitIdentity(task.repoPath) : null,
    // The repo's services run beside every stage that runs its code; a read-only stage only reads.
    services: limits.writable ? policy.services : {},
    input: input as unknown as Record<string, unknown>,
    // The input's budget, which implementing scales with the plan's slice count.
    timeoutMs: input.limits.timeoutMs,
    credential: { env: credential.env, mounts: credential.mounts },
    labels: { "dev.hardness.task": task.id },
    mounts: [
      ...(graphContext && graphDir ? [{ host: graphDir, container: GRAPH_MOUNT, readOnly: true }] : []),
      // The worktree's `.git` file points at its admin dir: read-only, so no stage can repoint the checkout.
      ...(extra.mounts ?? []),
    ],
    // The graph's path for the pack, and what the stage container needs to continue the machine's trace.
    extraEnv: { ...(graphContext && graphDir ? { LUNA_GRAPH: GRAPH_FILE } : {}), ...(context.traceEnv ?? {}), ...(qaCredentialNames.length > 0 ? { LUNA_QA_CREDENTIALS: qaCredentialNames.join(",") } : {}) },
    signal: context.signal,
    // The tab's label names the repo too: five repos' Build tabs read apart.
    onStarted: (name) => {
      startWatch();
      void deps.watcher.follow(task.id, `#${task.id.slice(0, 8)} ${basename(task.repoPath!)} · ${task.title}`, workspace.path, name);
    },
    onLine: (line) => detector.feed(line),
  }).finally(async () => {
    // A fake or resumed sandbox may never call onStarted; the watch still covers its run.
    startWatch();
    await (watch as ReturnType<typeof buildWatch> | null)?.stop();
    await pushing;
    credential.release();
  });
  } catch (error) {
    if (!(error instanceof EgressUnsupportedError)) throw error;
    return { outcome: "escalated", detail: { escalation: "env_broken", envBroken: true, step: "network", reason: error.message, options: ["install Docker Engine 28.0 or newer, or set MACHINE_EGRESS=off on the machine to run without the allow-list, then resume"] } };
  }
  // A run that had secrets: what its tools wrote into the files it left is cleaned before anything reads the packet, and every string of
  // what is ingested below is cleaned where it is made.
  const known = { ...(extra.redactValues ?? {}), ...(secretValues ?? {}) };
  const redact = secretRedactor(known);
  const hasSecrets = Object.keys(known).length > 0;
  if (hasSecrets) await redactFiles(join(runDir, "out", "files"), redact);
  for (const payload of blockedPayloads(sandbox.blocked, "stage")) await Promise.resolve(context.emit?.("sandbox.egress_blocked", payload)).catch(() => {});

  const base: StageResult = {
    outcome: "fail",
    ...(engineEvents.length ? { events: engineEvents } : {}),
    // A checkout run has no workspace of the task's own to record.
    ...(extra.checkout ? {} : { workspace: { branch: workspace.branch, worktreePath: workspace.path } }),
    run: { containerId: container, transcriptPath: sandbox.transcriptPath, inputCommit },
  };
  // However this run ends without a clean, committed answer, the next attempt should not
  // inherit whatever it left half-edited on disk.
  const dirty = async <T>(result: T): Promise<T> => {
    if (limits.writable) await resetWorktree(workspace.path);
    return result;
  };
  // What the run left in its ledger survives an abort, a timeout or a stuck stop: the next attempt resumes from it.
  const keptLedger = async () => {
    try {
      return Ledger.parse(JSON.parse(await readRegularFile(join(runDir, "out", "ledger.json"), 4 * 1024 * 1024)));
    } catch {
      return null;
    }
  };
  const failed = async (error: string, extraDetail: Record<string, unknown> = {}): Promise<StageResult> => {
    const ledger = await keptLedger();
    // Whatever text the container left (the stuck line, the ingest error's message, the kept ledger) is cleaned of the run's secrets before it is stored.
    const detail = { error, ...extraDetail, ...(ledger ? { ledger } : {}), ...(pushes.attempted ? { pushes } : {}) };
    return dirty({ ...base, detail: hasSecrets ? (redactDeep(detail, redact) as Record<string, unknown>) : detail });
  };

  // A nested repository (a `.git` below the folder's top level) is data no host git may read: with a gitlink for it git would start a
  // child in it and read its own configuration. The walk follows no link; what it finds is removed by plain file removal, and the run fails.
  if (!extra.checkout) {
    const nested = removeNestedRepositories(workspace.path);
    if (nested.length > 0) return failed(`the run left a nested repository (${nested.join(", ")}); it was removed and nothing in the folder was read by git`);
  }
  // The run's commits come into the card's repository first, whatever way it ended: only as a fast-forward of the card's branch.
  const imported = importer ? await importer.sync() : null;
  if (imported && !imported.ok) {
    if (imported.kind === "head_moved") return { ...base, outcome: "escalated", detail: { escalation: "head_moved", reason: imported.reason, options: [] } };
    return failed(`the run's commits could not be taken in: ${imported.reason}`);
  }
  if (sandbox.aborted) return failed("aborted");
  if (sandbox.timedOut) return failed(`timed out after ${input.limits.timeoutMs / MINUTE} minutes`);
  if (sandbox.stuck) return failed(`stuck: ${sandbox.stuck}`);

  let ingested;
  try {
    ingested = await ingestStageOutput({ outDir: join(runDir, "out"), runId: context.runId, stateDir: deps.stateDir });
    if (hasSecrets) ingested = redactDeep(ingested, redact) as typeof ingested;
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException)?.code === "ENOENT";
    return failed(
      missing
        ? `the container left no result (exit code ${sandbox.exitCode}); see the transcript`
        : String((error as Error).message ?? error),
      // Docker's own codes for a container that could not be created or started (125, 126, 127): the environment, not the change.
      missing && [125, 126, 127].includes(Number(sandbox.exitCode)) ? { envBroken: true } : {},
    );
  }
  const { output } = ingested;
  const mapped = toStageResult(ingested);
  if (pushes.attempted) mapped.detail = { ...mapped.detail, pushes };
  const merged = (result: StageResult): StageResult => ({
    ...base,
    ...result,
    run: { ...base.run, ...result.run },
    ...(engineEvents.length ? { events: [...engineEvents, ...(result.events ?? [])] } : {}),
  });

  // A usage window spent mid-run leaves no answer: pause until it resets. A run that still
  // finished with one keeps it; the answer is paid for, and the next stage finds out for
  // itself whether the window is open. The reset time rides along for the record.
  const unfinished = !output.ok || output.outcome === "fail" || (output.answer == null && output.outcome === "pass");
  if (output.rateLimited && unfinished) return dirty(merged({ ...mapped, outcome: "fail", rateLimited: true }));
  if (output.rateLimited) {
    mapped.rateLimited = undefined;
    mapped.detail = { ...mapped.detail, usageWindow: { resetsAt: output.resetsAt ?? null } };
  }
  if (output.outcome === "fail" || !output.ok) {
    return dirty(
      merged({ ...mapped, outcome: "fail", detail: { ...mapped.detail, error: output.error ?? output.summary, runFailed: true } }),
    );
  }
  if (output.outcome === "needs_input") {
    const answered = answerOf(output.answer)?.questions;
    return merged({
      ...mapped,
      detail: {
        summary: output.summary,
        questions: Array.isArray(answered) ? answered : (output.needsInput ?? []),
        ...(output.answer ? { answer: output.answer } : {}),
      },
    });
  }
  if (output.outcome === "test_change") {
    return merged({ ...mapped, detail: { request: output.summary } });
  }

  // The agent stopped on purpose. Runners before the `escalated` outcome reported this as a pass.
  const stopped = answerOf(output.answer);
  if (output.outcome === "escalated" || stopped?.kind === "escalated") {
    // An escalated card's clone stays exactly as the agent left it: nothing is reset or cleaned. What it left
    // uncommitted is also saved on refs/luna/kept/<run>, so a resume that resets the tree loses nothing.
    let kept: Record<string, unknown> | null = null;
    if (limits.writable && !extra.checkout) {
      const saved = await saveKept({ stateDir: deps.stateDir, taskId: task.id, runId: context.runId, path: workspace.path, keepHours: policy.factory.sandbox.keep_hours });
      kept = saved.ok ? { path: saved.path, ref: saved.ref, until: saved.until, keepHours: policy.factory.sandbox.keep_hours } : { path: workspace.path, error: saved.reason };
    } else if (limits.writable) {
      await dirty(null);
    }
    return (
      merged({
        ...mapped,
        outcome: "escalated",
        detail: {
          ...mapped.detail,
          summary: output.summary,
          reason: typeof stopped?.reason === "string" && stopped.reason ? stopped.reason : output.summary,
          options: Array.isArray(stopped?.options) ? stopped.options : [],
          escalation: EscalationReason.safeParse(stopped?.escalation).data ?? "other",
          ...(kept ? { keptSandbox: kept } : {}),
        },
      })
    );
  }

  // outcome pass
  if (pack === "build_tests") {
    // The writer's own per-scenario red reports (scenario_red), as data: the step judges them, the writer's word decides nothing.
    return merged({ ...mapped, detail: { ...mapped.detail, scenarioReds: await readScenarioReds(join(runDir, "out")) } });
  }
  if (pack === "implementing" || pack === "verifying") {
    // Both commit inside the container; anything left over is not part of the answer.
    const left = await dirtyFiles(workspace.path);
    if (left.length > 0) {
      const who = pack === "implementing" ? "implementer" : "verifying";
      const named = left.slice(0, 10).join(", ") + (left.length > 10 ? `, and ${left.length - 10} more` : "");
      return dirty(merged({ ...mapped, outcome: "fail", detail: { error: `${who} left uncommitted changes: ${named}` } }));
    }
    // Tests present at the start of the run are locked; implementing has a test_change
    // escape hatch, verifying has none — it may only ever add a new test file.
    const nameStatus = await diffNameStatus(workspace.path, inputCommit, "HEAD");
    // Locked are the repo's own tests (on its default branch). A test only a card's branch has was written for that work by the harness
    // (a tests step, an earlier card it builds on): the card may fix it. A README card's git-history test failed CI with the implementer
    // forbidden to touch it. Scenario tests stay protected by the scope check (a weakened test is a blocker).
    const touchedTests = lockedFilesTouched(nameStatus);
    const repoTests = touchedTests.length && task.repoPath ? await onDefaultBranch(task.repoPath, touchedTests).catch(() => new Set(touchedTests)) : new Set(touchedTests);
    const locked = touchedTests.filter((path) => repoTests.has(path));
    let replayed = false;
    let replayError: string | null = null;
    if (locked.length > 0) {
      // A test file that existed may gain cases (the repo's idiom for a new export), but the
      // tests that were there must still pass against the new code, unchanged. Put the
      // originals back, run the project's test command, then restore the agent's versions.
      // A deleted or renamed-away test file has nothing to replay and stays a hard fail.
      const removed = lockedFilesRemoved(nameStatus).filter((path) => repoTests.has(path));
      const found = removed.length === 0 ? await (deps.detect ?? detectChecks)(workspace.path) : null;
      if (found?.test) {
        await restoreFiles(workspace.path, inputCommit, locked);
        const [cmd, ...args] = found.test;
        const ran = await (deps.exec ?? exec)(cmd!, args, {
          cwd: workspace.path,
          signal: context.signal,
          timeoutMs: LOCKED_REPLAY_TIMEOUT_MS,
          env: { ...process.env, HARDNESS_STAGE: pack },
          services: policy.services,
          repoPath: task.repoPath,
        });
        await resetWorktree(workspace.path);
        if (ran.code === 0) replayed = true;
        else {
          // Exit 127 is "command not found": the suite never ran (vitest not installed, say),
          // which is not the same as the original tests failing. Either way, show the tail.
          const tail = `${ran.stdout}\n${ran.stderr}`.trim().split("\n").slice(-12).join("\n");
          replayError =
            ran.code === 127
              ? `changed existing test file(s), and the test command could not run to prove them (\`${found.test.join(" ")}\`, exit 127; install what it needs first): ${locked.join(", ")}\n${tail}`
              : `changed existing test file(s) and the tests that were there no longer pass: ${locked.join(", ")}\n${tail}`;
        }
      }
    }
    if (replayed) mapped.detail = { ...mapped.detail, lockedFiles: locked, lockedTestsReplayed: true };
    // Where the run left the branch; a later test_change reverts verifying's tests by this.
    mapped.run = { ...mapped.run, outputCommit: await headCommit(workspace.path) };
    if (locked.length > 0 && !replayed) {
      // Undo the commit itself, so the next attempt does not start from it.
      await resetWorktree(workspace.path, inputCommit);
      const hint = pack === "implementing" ? " without a test_change request" : "";
      return merged({
        ...mapped,
        outcome: "fail",
        detail: {
          error: replayError ?? `modified existing test file(s)${hint}: ${locked.join(", ")}`,
          lockedFiles: locked,
        },
        findings: locked.map((path) => ({
          path,
          line: 0,
          start_line: null,
          severity: "test",
          title: "locked test file changed",
          body:
            replayError ??
            (pack === "implementing"
              ? "Tests present at the start of the run are locked; answer kind test_change instead of editing them."
              : "Tests present at the start of the run are locked; add a new test file instead of editing this one."),
          suggestion_code: null,
          confidence: 1,
        })),
      });
    }
    // The change's scope, from the final diff: a file outside the plan that the answer did not declare, or a
    // removed test, fails the stage here, before Verify. Declared files the machine accepted become graph misses.
    if (pack === "implementing" && checks) {
      const answered = OutOfMap.safeParse(answerOf(output.answer)?.outOfMap);
      const declared = answered.success ? answered.data : [];
      try {
        const facts = await checks.finalFacts(declared);
        const builtOn = (await stackOf(workspace.path)).branch ?? (await defaultBranch(task.repoPath).catch(() => null));
        mapped.detail = {
          ...mapped.detail,
          scope: { facts, verdict: await checks.lastVerdict() },
          // The agent's own summary of its diff, with git's facts over it.
          // The branch the card was cut from, for the Build Report.
          // (a stacked card: its parent's branch).
          ...(builtOn ? { base: builtOn } : {}),
          diffSummary: diffSummaryOf(answerOf(output.answer)?.diffSummary, { changed: facts.changed, newDependencies: facts.newDependencies, todos: facts.todos, mapFiles: (input.plan?.map?.files ?? []).map((f) => f.path) }),
        };
        // Every issue has a severity: a blocker fails the stage (one fix pass, then a person: the pipeline counts scope reds); a should_fix or a nit
        // rides along as a finding and does not fail it.
        const issues = scopeIssues(facts, await checks.lastJudged());
        mapped.detail = { ...mapped.detail, scope: { ...(mapped.detail?.scope as object), issues } };
        const asFinding = (issue: ScopeIssue) => ({
          path: issue.kind === "undeclared_file" || issue.kind === "test_removed" ? issue.text.split(":")[0]! : "",
          line: 0,
          start_line: null,
          severity: issue.severity === "blocker" ? "scope" : issue.severity,
          title: SCOPE_TITLES[issue.kind],
          body: issue.text,
          suggestion_code: null,
          confidence: 1,
        });
        const blockers = issues.filter((i) => i.severity === "blocker");
        if (blockers.length > 0) {
          return merged({
            ...mapped,
            outcome: "fail",
            detail: { ...mapped.detail, scopeRed: true, error: `scope check failed: ${blockers.map((i) => `${SCOPE_TITLES[i.kind]}${i.path ? ` (${i.path})` : ""}`).join("; ").slice(0, 1500)}` },
            findings: blockers.map((i) => ({ ...asFinding(i), body: SCOPE_ADVICE[i.kind] ?? i.text })),
          });
        }
        const rides = issues.filter((i) => i.severity !== "blocker").map(asFinding);
        if (rides.length > 0) mapped.findings = [...(mapped.findings ?? []), ...rides];
        const accepted = declared.filter((d) => facts.changed.includes(d.path)).map((d) => d.path);
        if (accepted.length > 0 && deps.graph && task.repoPath) {
          await deps.graph.recordMisses(task.repoPath, { task: task.id, at: new Date().toISOString(), files: accepted }).catch((e: Error) => void context.note?.(`graph misses not recorded: ${e.message}`).catch(() => {}));
        }
      } catch (error) {
        // Fail closed: a scope that cannot be computed is an environment problem for a person, not a pass.
        const message = safe((error as Error).message).slice(0, 200);
        await context.note?.(`scope facts unavailable: ${message}`).catch(() => {});
        return merged({ ...mapped, outcome: "escalated", detail: { ...mapped.detail, envBroken: true, reason: `the scope check could not be computed: ${message}` } });
      }
    }
  }
  if (pack === "triage") {
    const answer = answerOf(output.answer);
    const list = (value: unknown, fallback: unknown[]): unknown[] => (Array.isArray(value) ? value : fallback);
    return merged({
      ...mapped,
      detail: {
        ...mapped.detail,
        // Triage hands the plan stage a record and picks where the ticket goes; the plan stage owns the plan.
        brief: typeof answer?.summary === "string" ? answer.summary : output.summary,
        outcome: typeof answer?.outcome === "string" ? answer.outcome : "plan",
        ...(answer?.record ? { record: answer.record } : {}),
        criteria: list(answer?.criteria, task.criteria),
        ...(typeof answer?.reply === "string" ? { reply: answer.reply } : {}),
        ...(typeof answer?.archiveReason === "string" ? { archiveReason: answer.archiveReason } : {}),
      },
    });
  }
  if (pack === "plan" || pack === "plan_fast") {
    const answer = answerOf(output.answer);
    const list = (value: unknown, fallback: string[]): string[] => (Array.isArray(value) ? value.map(String) : fallback);
    const parsedSteps = z.array(AnswerStep).safeParse(answer?.steps);
    const planned = parsedSteps.success && parsedSteps.data.length > 0 ? stepsOfAnswer(parsedSteps.data) : null;
    return merged({
      ...mapped,
      detail: {
        ...mapped.detail,
        summary: typeof answer?.summary === "string" ? answer.summary : output.summary,
        brief: typeof answer?.brief === "string" ? answer.brief : typeof answer?.summary === "string" ? answer.summary : output.summary,
        criteria: list(answer?.criteria, task.criteria),
        assumptions: list(answer?.assumptions, []),
        // The v2.2 steps first: they become the slices Build, the designer and the scope check read; an answer with slices only keeps them.
        slices: planned ? planned.slices : Array.isArray(answer?.slices) ? answer.slices : [],
        ...(planned ? { steps: planned.steps } : {}),
        ...(Array.isArray(answer?.outOfScope) ? { outOfScope: list(answer.outOfScope, []) } : {}),
        ...(typeof answer?.migration === "string" ? { migration: answer.migration } : {}),
        ...(typeof answer?.changed === "string" ? { changed: safe(answer.changed).slice(0, 1000) } : {}),
        ...(Array.isArray(answer?.flags) ? { flags: list(answer.flags, []) } : {}),
        ...(typeof answer?.rollback === "string" ? { rollback: answer.rollback } : {}),
        // The fast planner refusing the lane: the plan stage plans again in full.
        ...(answer?.kind === "needs_full_plan" ? { needsFullPlan: true } : {}),
      },
    });
  }
  if (pack === "code_map") {
    const answer = answerOf(output.answer);
    return merged({ ...mapped, detail: { ...mapped.detail, summary: output.summary, ...(answer ? { map: answer } : {}) } });
  }
  if (pack === "test_design" || pack === "test_design_fast") {
    const answer = answerOf(output.answer);
    // The v2.2 scenarios (given/when/then, each tied to its criterion by id) first; an answer with v1 cases keeps them.
    const parsed = z.array(AnswerScenario).safeParse(answer?.scenarios);
    const scenarios = parsed.success && parsed.data.length > 0 ? scenariosOfAnswer(parsed.data, criteriaOf(extra.plan?.criteria ?? task.criteria), extra.plan?.round ?? 1) : null;
    const cases = scenarios ?? answer?.cases;
    return merged({ ...mapped, detail: { ...mapped.detail, summary: output.summary, cases: Array.isArray(cases) ? cases : [] } });
  }
  return merged(mapped);
}

/** The policy store for runners built without one (bootstrap passes the machine's). */
const sharedPolicies = new PolicyStore();

const answerOf = (answer: unknown): Record<string, unknown> | undefined =>
  answer && typeof answer === "object" ? (answer as Record<string, unknown>) : undefined;

// test_design is the plan stage (stages/plan.ts), built in bootstrap/stages.ts with the planner and the
// decisions. verifying, evidence, e2e, ci_watch and reviewing_memory are each wrapped in their own
// stage-specific runner in bootstrap/stages.ts (around the same runAgent call), so the
// blanket map below only needs the packs that are dispatched unmodified.
const AGENT_PACKS: PackId[] = ["triage", "implementing"];

/** Runners for the stages that run as packs. Every other stage stays a stub. */
export function agentRunners(deps: AgentDeps): Partial<Record<TaskState, StageRunner>> {
  return Object.fromEntries(
    AGENT_PACKS.map((pack) => [pack, (context: StageContext) => runAgent(deps, context, pack)]),
  );
}
