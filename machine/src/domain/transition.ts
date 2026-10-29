// The pipeline as a pure function: given a task's state and an event, return the next
// state and what the machine should do next. No database, no I/O, so every path is
// unit tested. The graph is documented in docs/architecture.md.
import { RUNNING, type TaskRoute, type TaskState } from "@hardness/contracts";

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
}

export const NO_RETRIES: Retries = { verify: 0, e2e: 0, ci: 0, total: 0 };

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
  | { type: "stage_done"; outcome: StageOutcome; reason?: string }
  | { type: "answered" }
  | { type: "approved" }
  | { type: "sent_back" }
  | { type: "rate_limited" }
  | { type: "window_reset" }
  | { type: "abort" }
  /** The stage loop threw outside any stage (a DB hiccup, a pool timeout): the task must not stay "running". */
  | { type: "crash"; error: string }
  /** The task spent past its ceiling; `reason` is the budget line shown on the board. */
  | { type: "over_budget"; reason: string };

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

function loopFailed(task: Snapshot, loop: Loop): Move {
  const retries = { ...task.retries, [loop]: task.retries[loop] + 1 };
  if (retries[loop] >= LOOP_CAP) {
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
    case "crash":
      if (RUNNING.has(state)) return escalate(`stage loop crashed: ${event.error}`, state, retries);
      break;
    case "over_budget":
      if (RUNNING.has(state)) return escalate(event.reason, state, retries);
      break;
    case "abort":
      if (RUNNING.has(state)) return escalate("aborted", state, retries);
      if (state === "paused_rate_limit" && task.resumeTo) {
        return escalate("aborted", task.resumeTo, retries);
      }
      break;
    case "rate_limited":
      if (RUNNING.has(state)) {
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
      if (state === "awaiting_answers") return run("triage", retries);
      break;
    case "approved":
      return approved(task, event);
    case "sent_back":
      if (state === "awaiting_setup") return run("setup", retries);
      // A review verdict sent back is dropped: the comment review already went out.
      if (task.route === "review" && state === "awaiting_ship") return done(retries);
      if (task.route !== "feature") break;
      if (state === "awaiting_approval") return run("triage", retries);
      if (state === "awaiting_test_check") return run("test_design", retries);
      break;
    case "stage_done":
      return stageDone(task, event);
  }
  throw new TransitionError(task, event);
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
    case "awaiting_approval":
      return run("test_design", retries);
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
      if (outcome === "fail") return loopFailed(task, "ci");
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
  const { state, retries } = task;
  const { outcome } = event;

  // The agent stopped on purpose and says why: a human decides, so no retry is spent.
  if (outcome === "escalated" && RUNNING.has(state)) {
    return escalate(event.reason || `${state} escalated`, state, retries);
  }
  if (task.route !== "feature" && task.route !== "setup") return prStageDone(task, event);

  switch (state) {
    case "setup":
      if (outcome === "pass") return wait("awaiting_setup", retries);
      if (outcome === "fail") return escalate("setup failed", "setup", retries);
      break;
    case "triage":
      if (outcome === "pass") return wait("awaiting_approval", retries);
      if (outcome === "needs_input") return wait("awaiting_answers", retries);
      if (outcome === "fail") return escalate("triage failed", "triage", retries);
      break;
    case "test_design":
      if (outcome === "pass") return wait("awaiting_test_check", retries);
      if (outcome === "fail") return escalate("test design failed", "test_design", retries);
      break;
    case "implementing":
      if (outcome === "pass") return run("verifying", retries);
      if (outcome === "test_change") return testChangeRequested(task);
      if (outcome === "fail") return enterImplementing(retries);
      break;
    case "verifying":
      if (outcome === "pass") return run("e2e", retries);
      if (outcome === "fail") return loopFailed(task, "verify");
      break;
    case "e2e":
      if (outcome === "pass") return run("delivering", retries);
      if (outcome === "fail") return loopFailed(task, "e2e");
      break;
    case "delivering":
      if (outcome === "pass") return run("ci_watch", retries);
      if (outcome === "fail") return escalate("deliver failed", "delivering", retries);
      break;
    case "ci_watch":
      if (outcome === "pass") return run("evidence", retries);
      if (outcome === "fail") return loopFailed(task, "ci");
      break;
    case "evidence":
      if (outcome === "pass") return wait("awaiting_ship", retries);
      // The criteria could not be shown working: that counts against the e2e loop.
      if (outcome === "fail") return loopFailed(task, "e2e");
      break;
    case "shipping":
      if (outcome === "pass") return wait("reviewing_memory", retries);
      if (outcome === "fail") return escalate("ship failed", "shipping", retries);
      break;
  }
  throw new TransitionError(task, event);
}
