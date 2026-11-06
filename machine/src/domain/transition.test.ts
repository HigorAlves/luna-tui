import { TERMINAL, type TaskRoute, TaskState } from "@hardness/contracts";
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

describe("archive", () => {
  const nonTerminal = TaskState.options.filter((s) => !TERMINAL.has(s));
  it.each(nonTerminal)("%s can be archived with a reason", (state) => {
    expect(transition(at(state, { route: routeOf(state) }), { type: "archive", reason: "duplicate" })).toMatchObject({ state: "archived", effect: { kind: "done" }, archiveReason: "duplicate" });
  });
  it.each([...TERMINAL])("%s cannot be archived again", (state) => {
    expect(() => transition(at(state), { type: "archive", reason: "rejected" })).toThrow(TransitionError);
  });
});

describe("evidence without the preview gate", () => {
  it("goes straight to shipping on a pass unless the repository keeps the preview", () => {
    const step = transition(at("evidence"), { type: "stage_done", outcome: "pass" });
    expect(step).toMatchObject({ state: "awaiting_ship", effect: { kind: "run", stage: "awaiting_ship" } });
    expect(transition(at("evidence"), { type: "stage_done", outcome: "pass", preview: false })).toMatchObject({ state: "awaiting_ship", effect: { kind: "run", stage: "awaiting_ship" } });
    expect(transition(at("evidence"), { type: "stage_done", outcome: "pass", preview: true })).toMatchObject({ state: "awaiting_ship", effect: { kind: "wait", gate: "awaiting_ship" } });
  });

  it("a card already at awaiting_ship is approved or sent back as before", () => {
    expect(transition(at("awaiting_ship"), { type: "sent_back" })).toMatchObject({ state: "evidence" });
  });
});

describe("evidence at the ship gate", () => {
  it("a feature task sent back at awaiting_ship re-runs evidence", () => {
    expect(transition(at("awaiting_ship", { retries: { ...NO_RETRIES, total: 2 } }), { type: "sent_back" })).toMatchObject({ state: "evidence", effect: { kind: "run", stage: "evidence" }, retries: { total: 2 } });
  });
  it("a review verdict sent back at awaiting_ship is still dropped", () => {
    expect(transition(at("awaiting_ship", { route: "review" }), { type: "sent_back" })).toMatchObject({ state: "closed" });
  });
  it("head_moved from shipping re-runs evidence with retries and the reason kept", () => {
    const retries = { ...NO_RETRIES, total: 2, e2e: 1 };
    const step = transition(at("shipping", { retries }), { type: "stage_done", outcome: "escalated", escalation: "head_moved", reason: "the PR head moved (abc1234 to def5678)" });
    expect(step).toMatchObject({ state: "evidence", effect: { kind: "run", stage: "evidence" }, retries: { total: 2, e2e: 1 }, reason: "the PR head moved (abc1234 to def5678)" });
  });
  it("head_moved from any other stage waits for a person", () => {
    for (const state of ["verifying", "delivering", "evidence"] as const) {
      expect(transition(at(state), { type: "stage_done", outcome: "escalated", escalation: "head_moved", reason: "r" })).toMatchObject({ state: "escalated", resumeTo: state, escalation: "head_moved" });
    }
  });
  it("head_moved from shipping on a review route waits for a person", () => {
    expect(transition(at("shipping", { route: "review" }), { type: "stage_done", outcome: "escalated", escalation: "head_moved", reason: "r" }).state).toBe("escalated");
  });
});

describe("typed escalations", () => {
  it.each(["implementing", "verifying", "shipping"] as const)("plan_wrong from %s sends a feature task back to the planner (the plan stage), not to triage, with its retries kept", (state) => {
    const step = transition(at(state, { retries: { ...NO_RETRIES, total: 2 } }), { type: "stage_done", outcome: "escalated", escalation: "plan_wrong", reason: "the plan names a module that does not exist" });
    expect(step).toMatchObject({ state: "test_design", effect: { kind: "run", stage: "test_design" }, retries: { total: 2, planWrong: 1 }, escalation: "plan_wrong", reason: "the plan names a module that does not exist" });
  });
  it("a second plan_wrong on the same card waits for a person", () => {
    const step = transition(at("implementing", { retries: { ...NO_RETRIES, total: 2, planWrong: 1 } }), { type: "stage_done", outcome: "escalated", escalation: "plan_wrong", reason: "still wrong" });
    expect(step).toMatchObject({ state: "escalated", resumeTo: "implementing", escalation: "plan_wrong" });
  });
  it.each(["env_broken", "flaky_tests", "too_complex", "undeclared_scope", "other"] as const)("%s waits for a person", (escalation) => {
    const step = transition(at("verifying"), { type: "stage_done", outcome: "escalated", escalation, reason: "r" });
    expect(step).toMatchObject({ state: "escalated", resumeTo: "verifying", escalation });
  });
  it("too_complex from implementing runs it once more, flagged for a stronger engine, with the reason", () => {
    const step = transition(at("implementing", { retries: { ...NO_RETRIES, total: 1 } }), { type: "stage_done", outcome: "escalated", escalation: "too_complex", reason: "the refactor spans six modules" });
    expect(step).toMatchObject({ state: "implementing", effect: { kind: "run", stage: "implementing" }, retries: { total: 2, stronger: 1, strongerNext: true }, reason: "the refactor spans six modules" });
  });
  it("a second too_complex, or one past the implementer's cap, waits for a person", () => {
    const again = transition(at("implementing", { retries: { ...NO_RETRIES, total: 2, stronger: 1 } }), { type: "stage_done", outcome: "escalated", escalation: "too_complex", reason: "r" });
    expect(again).toMatchObject({ state: "escalated", resumeTo: "implementing", escalation: "too_complex" });
    const capped = transition(at("implementing", { retries: { ...NO_RETRIES, total: IMPLEMENTER_CAP } }), { type: "stage_done", outcome: "escalated", escalation: "too_complex", reason: "r" });
    expect(capped.state).toBe("escalated");
  });
  it("the stronger run's own end clears the flag, so the next attempt runs on the default engine", () => {
    const step = transition(at("implementing", { retries: { ...NO_RETRIES, total: 2, stronger: 1, strongerNext: true } }), { type: "stage_done", outcome: "pass" });
    expect(step.state).toBe("verifying");
    expect(step.retries).not.toHaveProperty("strongerNext");
    expect(step.retries.stronger).toBe(1);
  });
  it("plan_wrong on a PR route still escalates: there is no plan to redo", () => {
    expect(transition(at("addressing", { route: "address" }), { type: "stage_done", outcome: "escalated", escalation: "plan_wrong", reason: "r" }).state).toBe("escalated");
  });
  it("plan_wrong from triage itself waits for a person: re-running it would loop", () => {
    expect(transition(at("triage"), { type: "stage_done", outcome: "escalated", escalation: "plan_wrong", reason: "r" }).state).toBe("escalated");
  });
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
      { type: "stage_done", outcome: "pass", triage: "plan" }, // triage
      pass, // plan stage: planner, test design, checks
      approved, // the one approval, after the scenarios
      pass, // implementing
      pass, // verifying
      pass, // e2e
      pass, // delivering
      pass, // ci_watch
      { ...pass, preview: true }, // evidence, the repository keeps the preview gate
      approved, // the preview gate: publishes and starts the watch
      pass, // the watch at awaiting_ship: a merge to make
      pass, // shipping: the merge
      approved, // memory proposals
    ]);

    expect(steps.map((s) => s.state)).toEqual([
      "triage",
      "test_design",
      "awaiting_approval",
      "implementing",
      "verifying",
      "e2e",
      "delivering",
      "ci_watch",
      "evidence",
      "awaiting_ship",
      "awaiting_ship",
      "shipping",
      "reviewing_memory",
      "closed",
    ]);
    expect(steps.at(-1)?.effect).toEqual({ kind: "done" });
    expect(steps.at(-1)?.retries).toEqual({ ...NO_RETRIES, total: 1 });
  });

  it("asks to run each stage and to wait at each gate", () => {
    const [started, triaged, planned] = play(at("draft"), [{ type: "start" }, pass, pass]);
    expect(started?.effect).toEqual({ kind: "run", stage: "triage" });
    expect(triaged?.effect).toEqual({ kind: "run", stage: "test_design" });
    expect(planned?.effect).toEqual({ kind: "wait", gate: "awaiting_approval" });
  });

  it("never reaches awaiting_test_check on the feature route (the state stays valid)", () => {
    const steps = play(at("draft"), [{ type: "start" }, pass, pass, approved]);
    expect(steps.map((s) => s.state)).not.toContain("awaiting_test_check");
    expect(TaskState.options).toContain("awaiting_test_check");
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

  it("runs the plan stage after triage, in the fast lane too, and waits for a person on a reply or an archive", () => {
    for (const triage of ["plan", "fast_lane"] as const) {
      expect(transition(at("triage"), { type: "stage_done", outcome: "pass", triage })).toMatchObject({ state: "test_design", effect: { kind: "run", stage: "test_design" } });
    }
    for (const triage of ["conversation", "archive"] as const) {
      expect(transition(at("triage"), { type: "stage_done", outcome: "pass", triage })).toMatchObject({ state: "awaiting_approval", effect: { kind: "wait", gate: "awaiting_approval" } });
    }
  });

  it("ends a conversation closed once its reply is approved, and nowhere else", () => {
    expect(transition(at("awaiting_approval"), { type: "replied" })).toMatchObject({ state: "closed", effect: { kind: "done" } });
    expect(() => transition(at("triage"), { type: "replied" })).toThrow();
    expect(() => transition(at("awaiting_ship"), { type: "replied" })).toThrow();
  });

  it("re-runs triage when a triage gate is sent back, and the plan stage when the plan is", () => {
    expect(transition(at("awaiting_approval"), { type: "sent_back", from: "triage" }).state).toBe("triage");
    expect(transition(at("awaiting_approval"), { type: "sent_back", from: "plan" }).state).toBe("test_design");
    expect(transition(at("awaiting_approval"), sentBack).state).toBe("test_design");
  });

  it("asks the plan stage's questions at awaiting_answers and returns to that stage when they are answered", () => {
    const steps = play(at("test_design"), [{ type: "stage_done", outcome: "needs_input" }, { type: "answered" }]);
    expect(steps[0]).toMatchObject({ state: "awaiting_answers", resumeTo: "test_design" });
    expect(steps[1]).toMatchObject({ state: "test_design", effect: { kind: "run", stage: "test_design" }, resumeTo: null });
  });

  it("approves the plan into the implementer", () => {
    expect(transition(at("awaiting_approval"), approved)).toMatchObject({ state: "implementing", retries: { total: 1 } });
  });

  it("keeps awaiting_test_check's legacy edges", () => {
    expect(transition(at("awaiting_test_check"), approved).state).toBe("implementing");
    expect(transition(at("awaiting_test_check"), sentBack).state).toBe("test_design");
    expect(transition(at("test_design"), { type: "stage_done", outcome: "pass" }).state).toBe("awaiting_approval");
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

  it("never sends a card back to Build from Evidence: a failure asks a person and resumes at Evidence", () => {
    const start = at("implementing", { retries: { ...NO_RETRIES, total: 1 } });
    const last = play(start, [...toEvidence, fail]).at(-1);
    expect(last?.state).toBe("escalated");
    expect(last?.effect).toEqual({ kind: "wait", gate: "escalated" });
    expect(last?.resumeTo).toBe("evidence");
    expect(last?.retries.e2e).toBe(0);
  });

  it(`escalates after ${LOOP_CAP} failures in one loop`, () => {
    const start = at("verifying", { retries: { ...NO_RETRIES, verify: LOOP_CAP - 1, total: 3 } });
    const step = transition(start, fail);
    expect(step.state).toBe("escalated");
    expect(step.effect).toEqual({ kind: "wait", gate: "escalated" });
    expect(step.reason).toMatch(/verify failed 3 times/);
    expect(step.resumeTo).toBe("implementing");
  });

  it("takes the browser run's and CI's caps from the event, three when it has none", () => {
    const e2e = (loopCap?: number): PipelineEvent => ({ type: "stage_done", outcome: "fail", ...(loopCap ? { loopCap } : {}) });
    const two = at("e2e", { retries: { ...NO_RETRIES, e2e: 1, total: 2 } });
    expect(transition(two, e2e()).state).toBe("implementing");
    expect(transition(two, e2e(2))).toMatchObject({ state: "escalated", reason: "e2e failed 2 times" });
    const ci = at("ci_watch", { route: "ci_fix", retries: { ...NO_RETRIES, ci: 3, total: 2 } });
    expect(transition(ci, e2e(5)).state).not.toBe("escalated");
  });

  describe("one Build round per set of blocker findings", () => {
    const failing = (findingSet: string, buildRounds?: number): PipelineEvent => ({ type: "stage_done", outcome: "fail", findingSet, ...(buildRounds ? { buildRounds } : {}) });

    it("sends a first set to Build and remembers it", () => {
      const step = transition(at("verifying"), failing("k1"));
      expect(step.state).toBe("implementing");
      expect(step.retries.findingSet).toEqual({ key: "k1", rounds: 1 });
    });

    it("asks a person when the same set comes back after its rounds, with the findings named in the reason", () => {
      const step = transition(at("verifying", { retries: { ...NO_RETRIES, verify: 1, total: 2, findingSet: { key: "k1", rounds: 1 } } }), failing("k1"));
      expect(step.state).toBe("escalated");
      expect(step.reason).toMatch(/same findings came back after 1 round/);
      expect(step.resumeTo).toBe("implementing");
    });

    it("lets Build have more rounds when the config says so, and starts a new count for a new set", () => {
      const again = at("verifying", { retries: { ...NO_RETRIES, verify: 1, total: 2, findingSet: { key: "k1", rounds: 1 } } });
      expect(transition(again, failing("k1", 2)).state).toBe("implementing");
      expect(transition(again, failing("k2")).retries.findingSet).toEqual({ key: "k2", rounds: 1 });
    });

    it("keeps the loop cap for a failure with no blocker set", () => {
      expect(transition(at("verifying"), fail).retries.verify).toBe(1);
    });
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
    expect(() => transition(at("awaiting_approval"), { type: "over_budget", reason: "x" })).toThrow(TransitionError);
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

describe("stop at a gate (a Luna Notch Stop)", () => {
  it.each<[TaskState, TaskState]>([
    ["awaiting_setup", "setup"],
    ["awaiting_answers", "triage"],
    ["awaiting_approval", "test_design"],
    ["awaiting_test_check", "test_design"],
    ["awaiting_ship", "evidence"],
  ])("escalates a task at %s as stopped; a retry re-runs %s, the stage that opened the gate", (gate, stage) => {
    const step = transition(at(gate), { type: "stop" });
    expect(step).toMatchObject({ state: "escalated", resumeTo: stage, reason: "stopped", effect: { kind: "wait", gate: "escalated" } });
    expect(transition(step, approved)).toMatchObject({ state: stage, effect: { kind: "run", stage } });
  });

  it("re-runs the review at a review task's verdict gate", () => {
    expect(transition(at("awaiting_ship", { route: "review" }), { type: "stop" })).toMatchObject({ resumeTo: "reviewing" });
  });

  it("is not a stop anywhere else: escalated, the memory rules, a running stage, a draft", () => {
    for (const state of ["escalated", "reviewing_memory", "implementing", "draft", "closed"] as TaskState[]) {
      expect(() => transition(at(state), { type: "stop" }), state).toThrow(TransitionError);
    }
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

  it("lets every state but the terminal ones move forward", () => {
    for (const state of TaskState.options.filter((s) => !TERMINAL.has(s))) {
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

describe("awaiting_ship and reviewing_memory hold a running stage or an open gate (feature route)", () => {
  it.each(["crash", "over_budget", "abort"] as const)("%s at awaiting_ship escalates with resumeTo awaiting_ship", (type) => {
    const event: PipelineEvent = type === "crash" ? { type, error: "x" } : type === "over_budget" ? { type, reason: "r" } : { type };
    expect(transition(at("awaiting_ship"), event)).toMatchObject({ state: "escalated", resumeTo: "awaiting_ship" });
    expect(transition(at("reviewing_memory"), event)).toMatchObject({ state: "escalated", resumeTo: "reviewing_memory" });
  });
  it("rate_limited at awaiting_ship pauses and the window reset resumes there", () => {
    const paused = transition(at("awaiting_ship"), { type: "rate_limited" });
    expect(paused).toMatchObject({ state: "paused_rate_limit", resumeTo: "awaiting_ship", effect: { kind: "pause" } });
    expect(transition(at("paused_rate_limit", { resumeTo: "awaiting_ship" }), { type: "window_reset" })).toMatchObject({ state: "awaiting_ship", effect: { kind: "run", stage: "awaiting_ship" } });
  });
  it("the review route's verdict gate is untouched", () => {
    expect(() => transition(at("awaiting_ship", { route: "review" }), { type: "crash", error: "x" })).toThrow(TransitionError);
  });
  it("stage_done at awaiting_ship: pass runs shipping, needs_input waits, fail escalates", () => {
    expect(transition(at("awaiting_ship"), { type: "stage_done", outcome: "pass" })).toMatchObject({ state: "shipping", effect: { kind: "run", stage: "shipping" } });
    expect(transition(at("awaiting_ship"), { type: "stage_done", outcome: "needs_input" })).toMatchObject({ state: "awaiting_ship", effect: { kind: "wait", gate: "awaiting_ship" } });
    expect(transition(at("awaiting_ship"), { type: "stage_done", outcome: "fail" })).toMatchObject({ state: "escalated", resumeTo: "awaiting_ship", reason: "the ship watch failed" });
  });
  it("plan_wrong from awaiting_ship runs the plan stage once per card", () => {
    const step = transition(at("awaiting_ship"), { type: "stage_done", outcome: "escalated", escalation: "plan_wrong", reason: "r" });
    expect(step).toMatchObject({ state: "test_design", retries: { planWrong: 1 }, escalation: "plan_wrong" });
    const again = transition(at("awaiting_ship", { retries: { ...NO_RETRIES, planWrong: 1 } }), { type: "stage_done", outcome: "escalated", escalation: "plan_wrong", reason: "r" });
    expect(again).toMatchObject({ state: "escalated", resumeTo: "awaiting_ship" });
  });
  it("head_moved from awaiting_ship or shipping runs evidence, or e2e when media are to be refreshed", () => {
    for (const state of ["awaiting_ship", "shipping"] as const) {
      expect(transition(at(state), { type: "stage_done", outcome: "escalated", escalation: "head_moved", reason: "r" })).toMatchObject({ state: "evidence" });
      expect(transition(at(state), { type: "stage_done", outcome: "escalated", escalation: "head_moved", reason: "r", refresh: "media" })).toMatchObject({ state: "e2e", effect: { kind: "run", stage: "e2e" } });
    }
  });
  it("another escalation at awaiting_ship asks a person and resumes there", () => {
    expect(transition(at("awaiting_ship"), { type: "stage_done", outcome: "escalated", reason: "stuck" })).toMatchObject({ state: "escalated", resumeTo: "awaiting_ship", reason: "stuck" });
  });
  it("shipping that is not ready hands the card back to the watch", () => {
    expect(transition(at("shipping"), { type: "stage_done", outcome: "fail", notReady: true })).toMatchObject({ state: "awaiting_ship", effect: { kind: "run", stage: "awaiting_ship" } });
    expect(transition(at("shipping"), { type: "stage_done", outcome: "fail" })).toMatchObject({ state: "escalated", resumeTo: "shipping" });
  });
  it("the ship approval's answers: approved runs shipping, sent_back runs the watch again; without the gate both are as before", () => {
    expect(transition(at("awaiting_ship"), { type: "approved", gate: "ship_approval" })).toMatchObject({ state: "shipping" });
    expect(transition(at("awaiting_ship"), { type: "sent_back", gate: "ship_approval" })).toMatchObject({ state: "awaiting_ship", effect: { kind: "run", stage: "awaiting_ship" } });
    // The preview gate (no `gate`, and any gate stored before this wave): approving publishes and starts the watch.
    expect(transition(at("awaiting_ship"), { type: "approved" })).toMatchObject({ state: "awaiting_ship", effect: { kind: "run", stage: "awaiting_ship" } });
    expect(transition(at("awaiting_ship"), { type: "sent_back" })).toMatchObject({ state: "evidence" });
  });
});
