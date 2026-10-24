import { TaskState } from "@hardness/contracts";
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
  ...overrides,
});

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
      const task = at(state, { resumeTo: state === "paused_rate_limit" ? "triage" : null });
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
