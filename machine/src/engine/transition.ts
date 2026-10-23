// The pipeline as a pure function: given a task's state and an event, return the next
// state and what the machine should do next. No database, no I/O, so every path is
// unit tested. The graph follows docs/plans/0001-machine-dev.md.
import { RUNNING, type TaskState } from "@hardness/contracts";

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
}

export type StageOutcome = "pass" | "fail" | "needs_input" | "test_change";

export type PipelineEvent =
  | { type: "start" }
  | { type: "stage_done"; outcome: StageOutcome }
  | { type: "answered" }
  | { type: "approved" }
  | { type: "sent_back" }
  | { type: "rate_limited" }
  | { type: "window_reset" }
  | { type: "abort" };

/** What the machine does after a transition. */
export type Effect =
  | { kind: "run"; stage: TaskState }
  | { kind: "wait"; gate: TaskState }
  | { kind: "pause" }
  | { kind: "done" };

export interface Step extends Snapshot {
  effect: Effect;
  /** Why the task was escalated, for the board. */
  reason?: string;
}

export class TransitionError extends Error {
  constructor(task: Snapshot, event: PipelineEvent) {
    super(`cannot apply "${event.type}" while the task is ${task.state}`);
    this.name = "TransitionError";
  }
}

const run = (stage: TaskState, retries: Retries): Step => ({
  state: stage,
  retries,
  resumeTo: null,
  effect: { kind: "run", stage },
});

const wait = (gate: TaskState, retries: Retries): Step => ({
  state: gate,
  retries,
  resumeTo: null,
  effect: { kind: "wait", gate },
});

/** Stops and asks you. On guidance, the task continues at `resumeTo`. */
const escalate = (reason: string, resumeTo: TaskState, retries: Retries): Step => ({
  ...wait("escalated", retries),
  resumeTo,
  reason,
});

function enterImplementing(retries: Retries): Step {
  if (retries.total >= IMPLEMENTER_CAP) {
    return escalate(`implementer used all ${IMPLEMENTER_CAP} runs`, "implementing", retries);
  }
  return run("implementing", { ...retries, total: retries.total + 1 });
}

function loopFailed(task: Snapshot, loop: Loop): Step {
  const retries = { ...task.retries, [loop]: task.retries[loop] + 1 };
  if (retries[loop] >= LOOP_CAP) {
    return escalate(`${loop} failed ${retries[loop]} times`, "implementing", retries);
  }
  return enterImplementing(retries);
}

function testChangeRequested(task: Snapshot): Step {
  const retries = { ...task.retries, total: task.retries.total + 1 };
  if (retries.total >= IMPLEMENTER_CAP) {
    return escalate(`implementer used all ${IMPLEMENTER_CAP} runs`, "test_design", retries);
  }
  return run("test_design", retries);
}

/** Continues an escalated task with a fresh retry budget. */
function resume(task: Snapshot): Step {
  const target = task.resumeTo ?? "implementing";
  return target === "implementing" ? enterImplementing(NO_RETRIES) : run(target, NO_RETRIES);
}

export function transition(task: Snapshot, event: PipelineEvent): Step {
  const { state, retries } = task;

  switch (event.type) {
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
      if (state === "draft") return run("triage", retries);
      break;
    case "answered":
      if (state === "awaiting_answers") return run("triage", retries);
      break;
    case "approved":
      return approved(task, event);
    case "sent_back":
      if (state === "awaiting_approval") return run("triage", retries);
      if (state === "awaiting_test_check") return run("test_design", retries);
      break;
    case "stage_done":
      return stageDone(task, event);
  }
  throw new TransitionError(task, event);
}

function approved(task: Snapshot, event: PipelineEvent): Step {
  const { state, retries } = task;
  switch (state) {
    case "awaiting_approval":
      return run("test_design", retries);
    case "awaiting_test_check":
      return enterImplementing(retries);
    case "awaiting_publish":
      return wait("reviewing_memory", retries);
    case "reviewing_memory":
      return { state: "closed", retries, resumeTo: null, effect: { kind: "done" } };
    case "escalated":
      return resume(task);
    default:
      throw new TransitionError(task, event);
  }
}

function stageDone(task: Snapshot, event: Extract<PipelineEvent, { type: "stage_done" }>): Step {
  const { state, retries } = task;
  const { outcome } = event;

  switch (state) {
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
      if (outcome === "pass") return wait("awaiting_publish", retries);
      // The criteria could not be shown working: that counts against the e2e loop.
      if (outcome === "fail") return loopFailed(task, "e2e");
      break;
  }
  throw new TransitionError(task, event);
}
