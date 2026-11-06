// The pipeline as a pure function: given a task's state and an event, return the next
// state and what the machine should do next. No database, no I/O, so every path is
// unit tested. The graph is documented in docs/architecture.md.
import { nextRound, type FindingSetRounds } from "./finding-sets.ts";
import { type ArchiveReason, type EscalationReason, FACTORY_DEFAULTS, PACKS, RUNNING, RUN_OR_GATE, TERMINAL, type TaskRoute, type TaskState, type TriageOutcome, stronger } from "@hardness/contracts";

/** Failures allowed in one retry loop (verify, e2e, ci) before asking you. */
export const LOOP_CAP = 3;
/** Implementer runs allowed per task, counting test change requests. */
export const IMPLEMENTER_CAP = 6;

export type Loop = "verify" | "e2e" | "ci";

export interface Retries {
  verify: number;
  e2e: number;
  ci: number;
  /** Implementer runs started, plus test change requests. */
  total: number;
  /** Implementer runs taken on a stronger engine after a too_complex escalation: one is all a task gets. */
  stronger: number;
  /** The next implementing run is that one shot; the pipeline reads it as the run starts and the run's own end clears it. */
  strongerNext?: boolean;
  /** Times a plan found wrong in Build, Verify or review went back to the planner: the second goes to a person. */
  planWrong?: number;
  /** The set of blocker findings Build was last sent from Verify, and the rounds it has had on it. */
  findingSet?: FindingSetRounds;
}

export const NO_RETRIES: Retries = { verify: 0, e2e: 0, ci: 0, total: 0, stronger: 0 };

export interface Snapshot {
  state: TaskState;
  retries: Retries;
  /** Where a paused or escalated task goes when it continues. */
  resumeTo: TaskState | null;
  /** Which graph the task walks: the feature pipeline, setup only, or one of the PR task routes. */
  route: TaskRoute;
}

export type StageOutcome = "pass" | "fail" | "needs_input" | "test_change" | "escalated";

export type PipelineEvent =
  /** `setup` when the repo has no luna.yaml yet: the setup gate runs before triage. */
  | { type: "start"; setup?: boolean }
  /** `triage` is the outcome triage picked; absent means `plan`. */
  | { type: "stage_done"; outcome: StageOutcome; /** Verify's blocker set (`blockerSetKey`) and `verify.build_rounds`: the same set back after that many rounds escalates. */ findingSet?: string; buildRounds?: number; /** The failures the loop of this stage may have before a person is asked (`verify.e2e_rounds`, `verify.ci_rounds`); `LOOP_CAP` when absent. */ loopCap?: number; /** For evidence: the repository keeps the preview gate (`ship.preview: on`). */ preview?: boolean; /** For shipping: the merge did not happen because the PR is not ready; the watch runs again. */ notReady?: boolean; /** For a head_moved escalation: the media are made again from a new browser run. */ refresh?: "media"; reason?: string; escalation?: EscalationReason; triage?: TriageOutcome }
  /** Ends the task without shipping or closing it: from any state that has not ended. */
  | { type: "archive"; reason: ArchiveReason }
  | { type: "answered" }
  /** A conversation outcome's reply was approved at its gate: the reply goes where the card came from and the card ends closed. */
  | { type: "replied" }
  /** `gate: "ship_approval"` says the answer is to the release question the watch asked, not to the preview gate. */
  | { type: "approved"; gate?: "ship_approval" }
  /** `from` says which stage opened the gate: `triage` (a reply or an archive to confirm) or `plan` (the plan stage's scenarios). */
  | { type: "sent_back"; from?: "triage" | "plan"; gate?: "ship_approval" }
  | { type: "rate_limited" }
  | { type: "window_reset" }
  | { type: "abort" }
  /** A Luna Notch Stop while the task waits at a gate: it escalates as "stopped" (the pipeline sends it for notch tasks only). */
  | { type: "stop" }
  /** The stage loop threw outside any stage (a DB hiccup, a pool timeout): the task must not stay "running". */
  | { type: "crash"; error: string }
  /** The task spent past its ceiling; `reason` is the budget line shown on the board. */
  | { type: "over_budget"; reason: string };

/** A state a stage runs in, on the feature route: the running states, and the two that can hold a stage as well as a gate. */
const runsStage = (task: Snapshot): boolean => RUNNING.has(task.state) || (task.route === "feature" && RUN_OR_GATE.has(task.state));

/** What the machine does after a transition. */
export type Effect =
  | { kind: "run"; stage: TaskState }
  | { kind: "wait"; gate: TaskState }
  | { kind: "pause" }
  | { kind: "done" }
  /** A plain state change: no stage runs, no approval gate opens. */
  | { kind: "move" };

export interface Step extends Snapshot {
  effect: Effect;
  /** Why the task was escalated, for the board. */
  reason?: string;
  /** Why the task was archived, when it was. */
  archiveReason?: ArchiveReason;
  /** The typed reason an escalating stage gave, when it gave one. */
  escalation?: EscalationReason;
}

/** A step before the route is stamped on it: what the graph functions build. */
type Move = Omit<Step, "route">;

export class TransitionError extends Error {
  constructor(task: Snapshot, event: PipelineEvent) {
    super(`cannot apply "${event.type}" while the task is ${task.state}`);
    this.name = "TransitionError";
  }
}

const run = (stage: TaskState, retries: Retries): Move => ({
  state: stage,
  retries,
  resumeTo: null,
  effect: { kind: "run", stage },
});

const wait = (gate: TaskState, retries: Retries): Move => ({
  state: gate,
  retries,
  resumeTo: null,
  effect: { kind: "wait", gate },
});

const move = (state: TaskState, retries: Retries): Move => ({
  state,
  retries,
  resumeTo: null,
  effect: { kind: "move" },
});

const done = (retries: Retries): Move => ({ state: "closed", retries, resumeTo: null, effect: { kind: "done" } });

/** Stops and asks you. On guidance, the task continues at `resumeTo`. */
const escalate = (reason: string, resumeTo: TaskState, retries: Retries): Move => ({
  ...wait("escalated", retries),
  resumeTo,
  reason,
});

function enterImplementing(retries: Retries): Move {
  if (retries.total >= IMPLEMENTER_CAP) {
    return escalate(`implementer used all ${IMPLEMENTER_CAP} runs`, "implementing", retries);
  }
  return run("implementing", { ...retries, total: retries.total + 1 });
}

function loopFailed(task: Snapshot, loop: Loop, set?: { key: string; buildRounds: number }, cap: number = LOOP_CAP): Move {
  const retries: Retries = { ...task.retries, [loop]: task.retries[loop] + 1 };
  if (set) {
    const round = nextRound(task.retries.findingSet, set.key, set.buildRounds);
    retries.findingSet = round.set;
    if (round.escalate) return escalate(`the same findings came back after ${round.set.rounds} round${round.set.rounds === 1 ? "" : "s"} of Build`, "implementing", retries);
  }
  if (retries[loop] >= cap) {
    return escalate(`${loop} failed ${retries[loop]} times`, "implementing", retries);
  }
  return enterImplementing(retries);
}

function testChangeRequested(task: Snapshot): Move {
  const retries = { ...task.retries, total: task.retries.total + 1 };
  if (retries.total >= IMPLEMENTER_CAP) {
    return escalate(`implementer used all ${IMPLEMENTER_CAP} runs`, "test_design", retries);
  }
  return run("test_design", retries);
}

/** Continues an escalated task with a fresh retry budget. */
function resume(task: Snapshot): Move {
  const target = task.resumeTo ?? "implementing";
  return target === "implementing" ? enterImplementing(NO_RETRIES) : run(target, NO_RETRIES);
}

export function transition(task: Snapshot, event: PipelineEvent): Step {
  return { ...next(task, event), route: task.route };
}

function next(task: Snapshot, event: PipelineEvent): Move {
  const { state, retries } = task;

  switch (event.type) {
    case "archive":
      if (TERMINAL.has(state)) break;
      return { state: "archived", retries, resumeTo: null, effect: { kind: "done" }, reason: event.reason, archiveReason: event.reason };
    case "crash":
      if (runsStage(task)) return escalate(`stage loop crashed: ${event.error}`, state, retries);
      break;
    case "over_budget":
      if (runsStage(task)) return escalate(event.reason, state, retries);
      break;
    case "abort":
      if (runsStage(task)) return escalate("aborted", state, retries);
      if (state === "paused_rate_limit" && task.resumeTo) {
        return escalate("aborted", task.resumeTo, retries);
      }
      break;
    case "stop": {
      const stage = gateStage(task);
      if (stage) return escalate("stopped", stage, retries);
      break;
    }
    case "rate_limited":
      if (runsStage(task)) {
        return { state: "paused_rate_limit", retries, resumeTo: state, effect: { kind: "pause" } };
      }
      break;
    case "window_reset":
      if (state === "paused_rate_limit" && task.resumeTo) return run(task.resumeTo, retries);
      break;
    case "start":
      // A feature on a repo with no luna.yaml yet runs the setup gate before its own entry.
      if (state === "draft") return run(task.route === "feature" && event.setup ? "setup" : ENTRY[task.route], retries);
      break;
    case "answered":
      if (state === "awaiting_answers") return run(task.resumeTo ?? "triage", retries);
      break;
    case "replied":
      if (state === "awaiting_approval" && task.route === "feature") return done(retries);
      break;
    case "approved":
      return approved(task, event);
    case "sent_back":
      if (state === "awaiting_setup") return run("setup", retries);
      // A review verdict sent back is dropped: the comment review already went out.
      if (task.route === "review" && state === "awaiting_ship") return done(retries);
      if (task.route !== "feature") break;
      // The ship gate is a preview: a note sends it back to Evidence, which makes the pack again.
      if (state === "awaiting_ship") return event.gate === "ship_approval" ? run("awaiting_ship", retries) : run("evidence", retries);
      if (state === "awaiting_approval") return run(event.from === "triage" ? "triage" : "test_design", retries);
      if (state === "awaiting_test_check") return run("test_design", retries);
      break;
    case "stage_done":
      return stageDone(task, event);
  }
  throw new TransitionError(task, event);
}

/** The stage that opened the gate a task waits at, which a stopped task re-runs when retried; null when it is not at an `awaiting_*` gate. */
function gateStage(task: Snapshot): TaskState | null {
  switch (task.state) {
    case "awaiting_setup":
      return "setup";
    case "awaiting_answers":
      return task.resumeTo ?? "triage";
    case "awaiting_approval":
    case "awaiting_test_check":
      return "test_design";
    case "awaiting_ship":
      return task.route === "review" ? "reviewing" : "evidence";
    default:
      return null;
  }
}

/** The first stage each route runs when a task starts. */
const ENTRY: Record<TaskRoute, TaskState> = {
  feature: "triage",
  setup: "setup",
  ci_fix: "ci_watch",
  review: "reviewing",
  address: "addressing",
};

function approved(task: Snapshot, event: PipelineEvent): Move {
  const { state, retries } = task;
  if (state === "escalated") return resume(task);
  if (task.route === "review") {
    // The verdict gate: `a` posts the APPROVE / REQUEST_CHANGES review.
    if (state === "awaiting_ship") return run("shipping", retries);
    throw new TransitionError(task, event);
  }
  // The setup gate: a setup-only task is done; a feature goes on to its own entry.
  if (state === "awaiting_setup") return task.route === "setup" ? done(retries) : run("triage", retries);
  if (task.route !== "feature") throw new TransitionError(task, event);
  switch (state) {
    // The one approval, after the plan stage's scenarios; awaiting_test_check is the legacy gate.
    case "awaiting_approval":
    case "awaiting_test_check":
      return enterImplementing(retries);
    case "awaiting_ship":
      return run("shipping", retries);
    case "reviewing_memory":
      return done(retries);
    default:
      throw new TransitionError(task, event);
  }
}

/**
 * The PR routes. `ci_fix` and `address` share one loop once a fix is on its way: implementing,
 * the project's checks, a push, then the PR's CI again. `review` posts a comment review and
 * closes, unless it has a verdict to post, which waits at `awaiting_ship` for you.
 */
function prStageDone(task: Snapshot, event: Extract<PipelineEvent, { type: "stage_done" }>): Move {
  const { state, retries } = task;
  const { outcome } = event;
  if (task.route === "review") {
    switch (state) {
      case "reviewing":
        if (outcome === "pass") return event.reason === "verdict" ? wait("awaiting_ship", retries) : done(retries);
        if (outcome === "fail") return escalate("review failed", "reviewing", retries);
        break;
      case "shipping":
        if (outcome === "pass") return done(retries);
        if (outcome === "fail") return escalate("posting the verdict failed", "shipping", retries);
        break;
    }
    throw new TransitionError(task, event);
  }
  switch (state) {
    case "addressing":
      if (outcome === "pass") return run("verifying", retries);
      if (outcome === "fail") return escalate("addressing the threads failed", "addressing", retries);
      break;
    case "ci_watch":
      if (outcome === "pass") return done(retries);
      if (outcome === "fail") return loopFailed(task, "ci", undefined, event.loopCap);
      break;
    case "implementing":
      if (outcome === "pass") return run("verifying", retries);
      if (outcome === "fail") return enterImplementing(retries);
      break;
    case "verifying":
      if (outcome === "pass") return run("delivering", retries);
      if (outcome === "fail") return loopFailed(task, "verify");
      break;
    case "delivering":
      if (outcome === "pass") return run("ci_watch", retries);
      if (outcome === "fail") return escalate("push failed", "delivering", retries);
      break;
  }
  throw new TransitionError(task, event);
}

function stageDone(task: Snapshot, event: Extract<PipelineEvent, { type: "stage_done" }>): Move {
  const { state } = task;
  // The stronger engine's one run is over whichever way it ended.
  const { strongerNext: _spent, ...retries } = task.retries;
  const { outcome } = event;

  // The agent stopped on purpose and says why: a human decides, so no retry is spent.
  if (outcome === "escalated" && (RUNNING.has(state) || (task.route === "feature" && state === "awaiting_ship"))) {
    // A plan that cannot be built as written goes back to the planner (the plan stage) with the evidence, retries kept and the record as triage
    // left it; the second time on the same card a person decides. On a PR route there is no plan to redo, and triage and setup have none.
    if (event.escalation === "plan_wrong" && task.route === "feature" && state !== "triage" && state !== "setup" && state !== "test_design" && (retries.planWrong ?? 0) < 1) {
      return { ...run("test_design", { ...retries, planWrong: (retries.planWrong ?? 0) + 1 }), reason: event.reason, escalation: "plan_wrong" };
    }
    // The PR head moved after the evidence pack was made: Evidence runs again, retries kept; its format is kept too.
    // From the watch or the merge; a fix that changed what a scenario shows asks for a new browser run first, and Evidence re-makes the media from it.
    if (event.escalation === "head_moved" && task.route === "feature" && (state === "shipping" || state === "awaiting_ship")) {
      return { ...run(event.refresh === "media" ? "e2e" : "evidence", retries), reason: event.reason };
    }
    // Too complex for the default engine: one more run on the pack's stronger one before a person is asked.
    if (event.escalation === "too_complex" && state === "implementing" && (retries.stronger ?? 0) < 1 && retries.total < IMPLEMENTER_CAP && stronger(PACKS.implementing)) {
      return { ...run("implementing", { ...retries, total: retries.total + 1, stronger: (retries.stronger ?? 0) + 1, strongerNext: true }), reason: event.reason };
    }
    return { ...escalate(event.reason || `${state} escalated`, state, retries), ...(event.escalation ? { escalation: event.escalation } : {}) };
  }
  if (task.route !== "feature" && task.route !== "setup") return prStageDone(task, event);

  switch (state) {
    case "setup":
      if (outcome === "pass") return wait("awaiting_setup", retries);
      if (outcome === "fail") return escalate("setup failed", "setup", retries);
      break;
    case "triage":
      // A reply or an archive waits for one click; everything else goes to the plan stage.
      if (outcome === "pass") return event.triage === "conversation" || event.triage === "archive" ? wait("awaiting_approval", retries) : run("test_design", retries);
      if (outcome === "needs_input") return wait("awaiting_answers", retries);
      if (outcome === "fail") return escalate("triage failed", "triage", retries);
      break;
    case "test_design":
      if (outcome === "pass") return wait("awaiting_approval", retries);
      if (outcome === "needs_input") return { ...wait("awaiting_answers", retries), resumeTo: "test_design" };
      if (outcome === "fail") return escalate("test design failed", "test_design", retries);
      break;
    case "implementing":
      if (outcome === "pass") return run("verifying", retries);
      if (outcome === "test_change") return testChangeRequested(task);
      if (outcome === "fail") return enterImplementing(retries);
      break;
    case "verifying":
      if (outcome === "pass") return run("e2e", retries);
      if (outcome === "fail") return loopFailed(task, "verify", event.findingSet ? { key: event.findingSet, buildRounds: event.buildRounds ?? FACTORY_DEFAULTS.verify.build_rounds } : undefined);
      break;
    case "e2e":
      if (outcome === "pass") return run("delivering", retries);
      if (outcome === "fail") return loopFailed(task, "e2e", undefined, event.loopCap);
      break;
    case "delivering":
      if (outcome === "pass") return run("ci_watch", retries);
      if (outcome === "fail") return escalate("deliver failed", "delivering", retries);
      break;
    case "ci_watch":
      if (outcome === "pass") return run("evidence", retries);
      if (outcome === "fail") return loopFailed(task, "ci", undefined, event.loopCap);
      break;
    case "evidence":
      // With the preview on a person approves the pack before anything is public; otherwise Evidence has published it and Ship takes over.
      if (outcome === "pass") return event.preview === true ? wait("awaiting_ship", retries) : run("shipping", retries);
      // Evidence shows less and says why; it never sends a card back to Build. A failure here is a card with no workspace, or a stage that broke: a person is asked, and the card resumes at Evidence.
      if (outcome === "fail") return escalate(event.reason || "evidence failed", "evidence", retries);
      break;
    case "awaiting_ship":
      // The watch: it ends with a merge to make, a question for a person, or a failure.
      if (outcome === "pass") return run("shipping", retries);
      if (outcome === "needs_input") return wait("awaiting_ship", retries);
      if (outcome === "fail") return escalate("the ship watch failed", "awaiting_ship", retries);
      break;
    case "shipping":
      if (outcome === "pass") return wait("reviewing_memory", retries);
      if (outcome === "fail" && event.notReady === true) return run("awaiting_ship", retries);
      if (outcome === "fail") return escalate("ship failed", "shipping", retries);
      break;
  }
  throw new TransitionError(task, event);
}
