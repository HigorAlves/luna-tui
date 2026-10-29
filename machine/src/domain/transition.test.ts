import { type TaskRoute, TaskState } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import {
  IMPLEMENTER_CAP,
  LOOP_CAP,
  NO_RETRIES,
  type PipelineEvent,
  type Snapshot,
  type Step,
  TransitionError,
  transition,
} from "./transition.ts";

const at = (state: TaskState, overrides: Partial<Snapshot> = {}): Snapshot => ({
  state,
  retries: { ...NO_RETRIES },
  resumeTo: null,
  route: "feature",
  ...overrides,
});

/** The route a state is only reachable on; everything else walks the feature pipeline. */
const routeOf = (state: TaskState): TaskRoute => (state === "reviewing" ? "review" : state === "addressing" ? "address" : "feature");

/** Applies events in order and returns every step, so tests can check the whole path. */
function play(start: Snapshot, events: PipelineEvent[]): Step[] {
  const steps: Step[] = [];
  let task = start;
  for (const event of events) {
    const step = transition(task, event);
    steps.push(step);
    task = step;
  }
  return steps;
}

const pass: PipelineEvent = { type: "stage_done", outcome: "pass" };
const fail: PipelineEvent = { type: "stage_done", outcome: "fail" };
const approved: PipelineEvent = { type: "approved" };
const sentBack: PipelineEvent = { type: "sent_back" };

/** From `implementing`, the events that reach a given loop's failure point. */
const toVerify = [pass];
const toE2e = [pass, pass];
const toCi = [pass, pass, pass, pass];
const toEvidence = [pass, pass, pass, pass, pass];

describe("happy path", () => {
  it("goes from draft to closed through every stage and gate", () => {
    const steps = play(at("draft"), [
      { type: "start" },
      pass, // triage
      approved, // plan
      pass, // test design
      approved, // test names
      pass, // implementing
      pass, // verifying
      pass, // e2e
      pass, // delivering
      pass, // ci_watch
      pass, // evidence
      approved, // ship targets
      pass, // shipping
      approved, // memory proposals
    ]);

    expect(steps.map((s) => s.state)).toEqual([
      "triage",
      "awaiting_approval",
      "test_design",
      "awaiting_test_check",
      "implementing",
      "verifying",
      "e2e",
      "delivering",
      "ci_watch",
      "evidence",
      "awaiting_ship",
      "shipping",
      "reviewing_memory",
      "closed",
    ]);
    expect(steps.at(-1)?.effect).toEqual({ kind: "done" });
    expect(steps.at(-1)?.retries).toEqual({ ...NO_RETRIES, total: 1 });
  });

  it("asks to run each stage and to wait at each gate", () => {
    const [started, triaged] = play(at("draft"), [{ type: "start" }, pass]);
    expect(started?.effect).toEqual({ kind: "run", stage: "triage" });
    expect(triaged?.effect).toEqual({ kind: "wait", gate: "awaiting_approval" });
  });
});

describe("gates", () => {
  it("asks questions when triage needs input, then re-runs triage", () => {
    const steps = play(at("triage"), [
      { type: "stage_done", outcome: "needs_input" },
      { type: "answered" },
    ]);
    expect(steps.map((s) => s.state)).toEqual(["awaiting_answers", "triage"]);
  });

  it("re-runs triage when the plan is sent back", () => {
    expect(transition(at("awaiting_approval"), sentBack).state).toBe("triage");
  });

  it("re-runs the test designer when test names are sent back", () => {
    expect(transition(at("awaiting_test_check"), sentBack).state).toBe("test_design");
  });
});

describe("retry loops", () => {
  it.each([
    ["verify", toVerify],
    ["e2e", toE2e],
    ["ci", toCi],
  ] as const)("sends %s failures back to the implementer", (loop, path) => {
    const start = at("implementing", { retries: { ...NO_RETRIES, total: 1 } });
    const steps = play(start, [...path, fail]);
    const last = steps.at(-1);
    expect(last?.state).toBe("implementing");
    expect(last?.retries[loop]).toBe(1);
    expect(last?.retries.total).toBe(2);
  });

  it("counts evidence failures against the e2e loop", () => {
    const start = at("implementing", { retries: { ...NO_RETRIES, total: 1 } });
    const last = play(start, [...toEvidence, fail]).at(-1);
    expect(last?.state).toBe("implementing");
    expect(last?.retries.e2e).toBe(1);
  });

  it(`escalates after ${LOOP_CAP} failures in one loop`, () => {
    const start = at("verifying", { retries: { ...NO_RETRIES, verify: LOOP_CAP - 1, total: 3 } });
    const step = transition(start, fail);
    expect(step.state).toBe("escalated");
    expect(step.effect).toEqual({ kind: "wait", gate: "escalated" });
    expect(step.reason).toMatch(/verify failed 3 times/);
    expect(step.resumeTo).toBe("implementing");
  });

  it(`escalates when the implementer has used all ${IMPLEMENTER_CAP} runs`, () => {
    const start = at("verifying", { retries: { ...NO_RETRIES, total: IMPLEMENTER_CAP } });
    const step = transition(start, fail);
    expect(step.state).toBe("escalated");
    expect(step.reason).toMatch(/implementer used all 6 runs/);
  });

  it("re-runs the implementer when its own run fails, within the budget", () => {
    const step = transition(at("implementing", { retries: { ...NO_RETRIES, total: 2 } }), fail);
    expect(step.state).toBe("implementing");
    expect(step.retries.total).toBe(3);
  });

  it("gives a fresh budget when you add guidance to an escalation", () => {
    const escalated = transition(
      at("verifying", { retries: { ...NO_RETRIES, verify: LOOP_CAP - 1, total: 3 } }),
      fail,
    );
    const resumed = transition(escalated, approved);
    expect(resumed.state).toBe("implementing");
    expect(resumed.retries).toEqual({ ...NO_RETRIES, total: 1 });
    expect(resumed.resumeTo).toBeNull();
  });
});

describe("escalations from the agent", () => {
  it("escalate at once with the agent's reason, and resume the same stage", () => {
    const retries = { ...NO_RETRIES, total: 2 };
    const step = transition(at("implementing", { retries }), {
      type: "stage_done",
      outcome: "escalated",
      reason: "the plan needs a new dependency",
    });
    expect(step).toMatchObject({ state: "escalated", resumeTo: "implementing", reason: "the plan needs a new dependency", retries });
    expect(transition(step, approved).state).toBe("implementing");
  });

  it("fall back to a generic reason when the agent gives none", () => {
    const step = transition(at("verifying"), { type: "stage_done", outcome: "escalated" });
    expect(step).toMatchObject({ state: "escalated", resumeTo: "verifying", reason: "verifying escalated" });
  });
});

describe("a crashed stage loop", () => {
  it("escalates a running task with the error as the reason, keeping its retries", () => {
    const retries = { ...NO_RETRIES, total: 2 };
    const step = transition(at("verifying", { retries }), { type: "crash", error: "db down" });
    expect(step).toMatchObject({ state: "escalated", resumeTo: "verifying", reason: "stage loop crashed: db down", retries });
  });

  it("is rejected outside a running state, so a late crash report cannot move a waiting task", () => {
    expect(() => transition(at("awaiting_approval"), { type: "crash", error: "x" })).toThrow(TransitionError);
  });
});

describe("a task over its budget", () => {
  it("escalates a running task with the budget line as the reason, keeping its retries", () => {
    const retries = { ...NO_RETRIES, total: 1 };
    const step = transition(at("implementing", { retries }), { type: "over_budget", reason: "budget: task spent $3.00 of $2.00" });
    expect(step).toMatchObject({ state: "escalated", resumeTo: "implementing", reason: "budget: task spent $3.00 of $2.00", retries });
  });

  it("is rejected outside a running state", () => {
    expect(() => transition(at("awaiting_ship"), { type: "over_budget", reason: "x" })).toThrow(TransitionError);
  });
});

describe("test change requests", () => {
  it("send the implementer back to the test designer and count toward the total", () => {
    const step = transition(at("implementing", { retries: { ...NO_RETRIES, total: 2 } }), {
      type: "stage_done",
      outcome: "test_change",
    });
    expect(step.state).toBe("test_design");
    expect(step.retries.total).toBe(3);
  });

  it("escalate once the request uses up the implementer budget", () => {
    const step = transition(
      at("implementing", { retries: { ...NO_RETRIES, total: IMPLEMENTER_CAP - 1 } }),
      { type: "stage_done", outcome: "test_change" },
    );
    expect(step.state).toBe("escalated");
  });
});

describe("stages that cannot retry", () => {
  it.each(["triage", "test_design", "delivering", "shipping"] as const)(
    "escalates when %s fails and resumes it after guidance",
    (stage) => {
      const escalated = transition(at(stage), fail);
      expect(escalated.state).toBe("escalated");
      expect(escalated.resumeTo).toBe(stage);
      expect(transition(escalated, approved)).toMatchObject({
        state: stage,
        effect: { kind: "run", stage },
      });
    },
  );
});

describe("rate limits", () => {
  it("pauses the running stage and resumes the same stage when the window resets", () => {
    const retries = { ...NO_RETRIES, verify: 1, total: 2 };
    const paused = transition(at("verifying", { retries }), { type: "rate_limited" });
    expect(paused).toMatchObject({
      state: "paused_rate_limit",
      resumeTo: "verifying",
      effect: { kind: "pause" },
      retries,
    });

    const resumed = transition(paused, { type: "window_reset" });
    expect(resumed).toMatchObject({
      state: "verifying",
      effect: { kind: "run", stage: "verifying" },
      retries,
      resumeTo: null,
    });
  });

  it("only pauses a running stage", () => {
    expect(() => transition(at("awaiting_approval"), { type: "rate_limited" })).toThrow(
      TransitionError,
    );
  });
});

describe("abort", () => {
  it("stops a running stage and asks you before re-running it", () => {
    const step = transition(at("implementing"), { type: "abort" });
    expect(step).toMatchObject({ state: "escalated", resumeTo: "implementing", reason: "aborted" });
  });

  it("can abort a paused task", () => {
    const paused = at("paused_rate_limit", { resumeTo: "e2e" });
    expect(transition(paused, { type: "abort" })).toMatchObject({
      state: "escalated",
      resumeTo: "e2e",
    });
  });

  it("cannot abort a task that is waiting on you", () => {
    expect(() => transition(at("awaiting_approval"), { type: "abort" })).toThrow(TransitionError);
  });
});

describe("invalid events", () => {
  it.each<[TaskState, PipelineEvent]>([
    ["draft", approved],
    ["triage", { type: "start" }],
    ["implementing", approved],
    ["awaiting_answers", approved],
    ["closed", { type: "start" }],
    ["paused_rate_limit", pass],
  ])("rejects %s + %o", (state, event) => {
    expect(() => transition(at(state), event)).toThrow(TransitionError);
  });

  it("explains what was rejected", () => {
    expect(() => transition(at("implementing"), approved)).toThrow(
      /cannot apply "approved" while the task is implementing/,
    );
  });
});

describe("graph coverage", () => {
  const candidates: PipelineEvent[] = [
    { type: "start" },
    pass,
    { type: "answered" },
    approved,
    { type: "window_reset" },
  ];

  it("lets every state except closed move forward", () => {
    for (const state of TaskState.options.filter((s) => s !== "closed")) {
      const task = at(state, { resumeTo: state === "paused_rate_limit" ? "triage" : null, route: routeOf(state) });
      const moves = candidates.filter((event) => {
        try {
          transition(task, event);
          return true;
        } catch {
          return false;
        }
      });
      expect(moves.length, `no way forward from ${state}`).toBeGreaterThan(0);
    }
  });
});

describe("PR task routes", () => {
  const verdict: PipelineEvent = { type: "stage_done", outcome: "pass", reason: "verdict" };

  it("ci_fix: a green poll closes; a red one loops through implementing, checks and a push back to ci_watch", () => {
    const green = play(at("draft", { route: "ci_fix" }), [{ type: "start" }, pass]);
    expect(green.map((s) => s.state)).toEqual(["ci_watch", "closed"]);
    expect(green.at(-1)?.effect).toEqual({ kind: "done" });

    const red = play(at("draft", { route: "ci_fix" }), [{ type: "start" }, fail, pass, pass, pass, pass]);
    expect(red.map((s) => s.state)).toEqual(["ci_watch", "implementing", "verifying", "delivering", "ci_watch", "closed"]);
    expect(red[1]?.retries).toEqual({ ...NO_RETRIES, ci: 1, total: 1 });
  });

  it(`ci_fix escalates after ${LOOP_CAP} red runs, and a failed push escalates at once`, () => {
    const start = at("ci_watch", { route: "ci_fix", retries: { ...NO_RETRIES, ci: LOOP_CAP - 1, total: 2 } });
    const step = transition(start, fail);
    expect(step.state).toBe("escalated");
    expect(step.reason).toMatch(/ci failed 3 times/);
    const push = transition(at("delivering", { route: "ci_fix" }), fail);
    expect(push.state).toBe("escalated");
    expect(push.resumeTo).toBe("delivering");
  });

  it("review: a comment verdict closes; approve or request changes waits, then a posts it or r closes", () => {
    const comment = play(at("draft", { route: "review" }), [{ type: "start" }, pass]);
    expect(comment.map((s) => s.state)).toEqual(["reviewing", "closed"]);

    const gated = play(at("draft", { route: "review" }), [{ type: "start" }, verdict]);
    expect(gated.map((s) => s.state)).toEqual(["reviewing", "awaiting_ship"]);
    expect(gated.at(-1)?.effect).toEqual({ kind: "wait", gate: "awaiting_ship" });

    const posted = play(gated.at(-1)!, [approved, pass]);
    expect(posted.map((s) => s.state)).toEqual(["shipping", "closed"]);
    const dropped = transition(gated.at(-1)!, sentBack);
    expect(dropped.state).toBe("closed");
    expect(dropped.effect).toEqual({ kind: "done" });
  });

  it("review: a failed review or a failed post escalates back to where it was", () => {
    expect(transition(at("reviewing", { route: "review" }), fail)).toMatchObject({ state: "escalated", resumeTo: "reviewing" });
    expect(transition(at("shipping", { route: "review" }), fail)).toMatchObject({ state: "escalated", resumeTo: "shipping" });
  });

  it("address: addressing, checks, push, then ci_watch closes on green and loops like ci_fix on red", () => {
    const steps = play(at("draft", { route: "address" }), [{ type: "start" }, pass, pass, pass, pass]);
    expect(steps.map((s) => s.state)).toEqual(["addressing", "verifying", "delivering", "ci_watch", "closed"]);
    const red = play(at("ci_watch", { route: "address" }), [fail, pass, pass, pass, pass]);
    expect(red.map((s) => s.state)).toEqual(["implementing", "verifying", "delivering", "ci_watch", "closed"]);
    expect(transition(at("addressing", { route: "address" }), fail)).toMatchObject({ state: "escalated", resumeTo: "addressing" });
  });

  it("the running PR states pause, abort, crash and escalate like any other", () => {
    for (const [state, route] of [["reviewing", "review"], ["addressing", "address"]] as const) {
      const task = at(state, { route });
      expect(transition(task, { type: "rate_limited" })).toMatchObject({ state: "paused_rate_limit", resumeTo: state });
      expect(transition(task, { type: "abort" })).toMatchObject({ state: "escalated", resumeTo: state });
      expect(transition(task, { type: "crash", error: "boom" })).toMatchObject({ state: "escalated", resumeTo: state });
      expect(transition(task, { type: "stage_done", outcome: "escalated", reason: "stuck" })).toMatchObject({ state: "escalated", reason: "stuck" });
      expect(transition(transition(task, { type: "abort" }), approved).state).toBe(state);
    }
  });

  it("a feature task never enters a PR state, and a PR task never enters triage", () => {
    expect(() => transition(at("reviewing"), pass)).toThrow(TransitionError);
    expect(transition(at("draft", { route: "review" }), { type: "start" }).state).toBe("reviewing");
    expect(() => transition(at("awaiting_approval", { route: "ci_fix" }), approved)).toThrow(TransitionError);
  });
});
