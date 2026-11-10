// The loop guard: what it asks, says and stops with as calls fold, in the modes that act and the modes that only record.
import { EconomyGuardEvent, LOOP_STUCK, type GuardInput, type Observation, type RunEvent } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import { LoopGuard, type GuardStep } from "./guard.ts";

const ON: GuardInput = { mode: "on", judge: true, envelope: 10, judgeConfidence: 0.7, redirects: 1, backstopMult: 2.5 };
const SAME = "aaaaaaaaaa";
const BASH = { tool: "bash", target: "pnpm test" };
const READ = { tool: "read", target: "src/a.ts" };

/** The signs of a stuck segment, in the first ten calls: 4 edits of one file, 6 error outputs, 4 repeats. */
const SIGNS: Observation[] = [
  { edits: ["src/a.ts"] },
  { edits: ["src/a.ts"] },
  { edits: ["src/a.ts"] },
  { edits: ["src/a.ts"] },
  { failure: SAME, errorClass: "TypeError" },
  { failure: SAME, errorClass: "TypeError" },
  { failure: SAME, errorClass: "TypeError" },
  { failure: SAME, errorClass: "TypeError" },
  { failure: SAME, errorClass: "TypeError" },
  { failure: "bbbbbbbbbb", errorClass: "Error" },
];

function setup(input: Partial<GuardInput> = {}) {
  const events: RunEvent[] = [];
  const guard = new LoopGuard({ ...ON, ...input }, (e) => events.push(e));
  /** Folds one call number `i` of the stuck pattern (quiet reads after the signs) and returns the step. */
  let i = 0;
  const next = (): GuardStep => {
    const o = SIGNS[i];
    i++;
    return o ? guard.fold(o, BASH) : guard.fold({}, READ);
  };
  const run = (n: number): GuardStep[] => Array.from({ length: n }, next);
  return { guard, events, next, run, calls: () => i };
}
const guardEvents = (events: RunEvent[], action: string) => events.filter((e) => e.kind === "economy.guard" && e.payload.action === action);
const stuck = { stuck: true, confidence: 0.9, cause: "same test, same failure" };

describe("LoopGuard in record mode", () => {
  for (const [name, input] of [
    ["record mode", { mode: "record" }],
    ["no envelope", { envelope: null }],
  ] as const) {
    it(`returns only none and records one gate event per segment with ${name}`, () => {
      const { run, events, guard } = setup(input);
      const steps = run(60);
      expect(steps.every((s) => s.kind === "none")).toBe(true);
      expect(guardEvents(events, "gate")).toHaveLength(1);
      expect(guardEvents(events, "judge")).toHaveLength(0);
      guard.verdict(stuck);
      expect(guard.fold({}, READ)).toEqual({ kind: "none" });
    });
  }

  it("records no gate event while the gate is shut", () => {
    const { run, events } = setup({ mode: "record" });
    run(19);
    expect(guardEvents(events, "gate")).toHaveLength(0);
  });
});

describe("LoopGuard judge requests", () => {
  it("asks nothing before the gate opens at 20 calls", () => {
    const { run } = setup();
    expect(run(19).every((s) => s.kind === "none")).toBe(true);
  });

  it("asks at the 20th call with a digest and emits a judge event", () => {
    const { run, events } = setup();
    const steps = run(20);
    expect(steps[19]!.kind).toBe("ask");
    expect(guardEvents(events, "judge")).toHaveLength(1);
    expect(guardEvents(events, "gate")).toHaveLength(1);
  });

  it("asks nothing with an ask outstanding", () => {
    const { run } = setup();
    expect(run(60).filter((s) => s.kind === "ask")).toHaveLength(1);
  });

  it("grows the gap by 5 after each productive verdict, up to 20", () => {
    const { next, guard } = setup({ backstopMult: 100 });
    const askedAt: number[] = [];
    for (let n = 1; n <= 120; n++) {
      if (next().kind === "ask") {
        askedAt.push(n);
        guard.verdict({ stuck: false, confidence: 0.9, cause: "progress" });
      }
    }
    expect(askedAt.slice(0, 6)).toEqual([20, 30, 45, 65, 85, 105]);
  });

  it("resets the gap to 5 after a stuck verdict under the confidence bar, as upstream grows it only on a verdict that is not stuck", () => {
    const { run, guard } = setup({ backstopMult: 100 });
    run(20);
    guard.verdict({ stuck: false, confidence: 0.9, cause: "progress" }); // the gap grows to 10
    run(10);
    guard.verdict({ stuck: true, confidence: 0.69, cause: "maybe" });
    const steps = run(5);
    expect(steps.slice(0, 4).every((s) => s.kind === "none")).toBe(true);
    expect(steps[4]!.kind).toBe("ask"); // 5 calls after the ask at 30, not 10
  });

  it("clears an outstanding ask on expire without growing the gap, so it asks again 5 calls later", () => {
    const { run, guard } = setup({ backstopMult: 100 });
    expect(run(20)[19]!.kind).toBe("ask");
    expect(run(10).every((s) => s.kind === "none")).toBe(true);
    guard.expire();
    const steps = run(10);
    expect(steps.findIndex((s) => s.kind === "ask")).toBe(0);
  });

  it("never asks with judge false", () => {
    const { run } = setup({ judge: false, backstopMult: 100 });
    expect(run(80).every((s) => s.kind === "none")).toBe(true);
  });
});

describe("LoopGuard redirect and stop", () => {
  it("redirects on the first stuck verdict, with the template, and starts a new segment", () => {
    const { run, guard, events, next } = setup();
    run(20);
    guard.verdict(stuck);
    const step = next();
    expect(step.kind).toBe("redirect");
    expect(step.kind === "redirect" && step.text).toContain("Process check (automated)");
    expect(guardEvents(events, "redirect")).toHaveLength(1);
    // A fresh segment: the gate needs 20 new calls before the judge is asked again.
    expect(run(18).every((s) => s.kind === "none")).toBe(true);
  });

  it("uses the verdict's redirect text, cut to 1,200 characters", () => {
    const { run, guard, next } = setup();
    run(20);
    guard.verdict({ ...stuck, redirect: "r".repeat(2000) });
    const step = next();
    expect(step.kind === "redirect" && step.text).toBe("r".repeat(1200));
  });

  it("stops on the next stuck verdict, with a reason that starts with LOOP_STUCK and holds no output text", () => {
    const { run, guard, next } = setup({ backstopMult: 100 });
    run(20);
    guard.verdict(stuck);
    next(); // redirect
    // A new segment of 20 calls that repeats the failures.
    const again = Array.from({ length: 20 }, (_, i) => (SIGNS[i] ? guard.fold(SIGNS[i]!, BASH) : guard.fold({}, READ)));
    expect(again[19]!.kind).toBe("ask");
    guard.verdict(stuck);
    const step = guard.fold({}, READ);
    expect(step.kind).toBe("stop");
    if (step.kind !== "stop") return;
    expect(step.reason.startsWith(LOOP_STUCK)).toBe(true);
    expect(step.reason).toBe(`${LOOP_STUCK}: same test, same failure, the same failure 10 times over 42 calls`);
  });

  it("repeats the same stop on every later fold", () => {
    const { run, guard, events } = setup({ redirects: 0 });
    run(20);
    guard.verdict(stuck);
    const stop = guard.fold({}, READ);
    expect(stop.kind).toBe("stop");
    expect(guard.fold({}, READ)).toEqual(stop);
    expect(guard.fold({ failure: SAME }, BASH)).toEqual(stop);
    expect(guardEvents(events, "stop")).toHaveLength(1);
  });

  it("stops at the first stuck verdict when redirects is 0", () => {
    const { run, guard } = setup({ redirects: 0 });
    run(20);
    guard.verdict(stuck);
    expect(guard.fold({}, READ).kind).toBe("stop");
  });

  it("ignores a verdict that arrives after a redirect reset the segment", () => {
    const { run, guard, next } = setup({ backstopMult: 100 });
    run(20);
    guard.verdict(stuck);
    next(); // redirect; no ask outstanding in the new segment
    guard.verdict(stuck);
    expect(run(15).every((s) => s.kind === "none")).toBe(true);
  });
});

describe("LoopGuard backstop", () => {
  it("redirects without a judge once a stuck segment passes backstopMult times the envelope", () => {
    // envelope 8, 2.5x: 20 calls, as upstream's `>=`.
    const { run, events } = setup({ judge: false, envelope: 8 });
    const steps = run(20);
    expect(steps.slice(0, 19).every((s) => s.kind === "none")).toBe(true);
    expect(steps[19]!.kind).toBe("redirect");
    expect(guardEvents(events, "redirect")[0]).toMatchObject({ payload: { cause: "backstop", confidence: 1 } });
  });

  it("does not fire within the multiple of the envelope", () => {
    const { run } = setup({ judge: false, envelope: 9 });
    expect(run(22).every((s) => s.kind === "none")).toBe(true);
  });

  it("stops at the backstop when no redirect is left", () => {
    const { run } = setup({ judge: false, envelope: 8, redirects: 0 });
    const steps = run(20);
    const last = steps[19]!;
    expect(last.kind === "stop" && last.reason).toContain(`${LOOP_STUCK}: backstop`);
  });

  it("is held off for 20 calls by a sure not-stuck verdict, and no longer", () => {
    // envelope 9, 2.5x: the backstop is due at call 23. The verdict lands on call 21 and holds it off through call 40.
    const { run, guard, next } = setup({ envelope: 9 });
    run(20);
    guard.verdict({ stuck: false, confidence: 1, cause: "progress" });
    expect(run(20).every((s) => s.kind === "none" || s.kind === "ask")).toBe(true);
    expect(next().kind).toBe("redirect");
  });

  it("is not held off by a not-stuck verdict under the confidence bar", () => {
    const { run, guard, next } = setup({ envelope: 9 });
    run(20);
    guard.verdict({ stuck: false, confidence: 0.5, cause: "progress" });
    expect(run(2).every((s) => s.kind === "none")).toBe(true);
    expect(next().kind).toBe("redirect");
  });

  it("is never held off past twice its length, however often the judge says not stuck", () => {
    // envelope 9, 2.5x: due at call 23, so a calm judge cannot hold it past call 45.
    const { guard, next } = setup({ envelope: 9 });
    let redirectAt = 0;
    for (let call = 1; call <= 80 && redirectAt === 0; call++) {
      const step = next();
      if (step.kind === "ask") guard.verdict({ stuck: false, confidence: 1, cause: "progress" });
      if (step.kind === "redirect") redirectAt = call;
    }
    expect(redirectAt).toBe(45);
  });
});

describe("LoopGuard cumulative backstop", () => {
  it("stops a run as soon as the fresh segment is stuck again, once the run's calls pass the backstop", () => {
    // envelope 20, 2.5x: 50 calls. No judge: only the backstop acts.
    const guard = new LoopGuard({ ...ON, judge: false, envelope: 20, backstopMult: 2.5 }, () => undefined);
    let inSegment = 0;
    let redirectAt = 0;
    let stopAt = 0;
    for (let call = 1; call <= 120 && stopAt === 0; call++) {
      const step = guard.fold(SIGNS[inSegment] ?? {}, SIGNS[inSegment] ? BASH : READ);
      inSegment++;
      if (step.kind === "redirect") {
        redirectAt = call;
        inSegment = 0;
      }
      if (step.kind === "stop") stopAt = call;
    }
    expect(redirectAt).toBe(50);
    expect(stopAt).toBe(redirectAt + 20);
  });

  it("does not stop a fresh segment that is not stuck, however many calls the run has made", () => {
    const guard = new LoopGuard({ ...ON, judge: false, envelope: 20, backstopMult: 2.5 }, () => undefined);
    const steps = Array.from({ length: 51 }, (_, i) => guard.fold(SIGNS[i] ?? {}, SIGNS[i] ? BASH : READ));
    expect(steps[49]!.kind).toBe("redirect");
    const calm = Array.from({ length: 60 }, () => guard.fold({}, READ));
    expect(calm.every((s) => s.kind === "none")).toBe(true);
  });
});

describe("LoopGuard digest", () => {
  const actions = (digest: string) => digest.split("Recent actions (oldest->newest):\n")[1]!.split("\n");

  it("holds at most 24 actions", () => {
    const { run, guard } = setup({ mode: "record" });
    run(60);
    expect(actions(guard.digest())).toHaveLength(24);
  });

  it("cuts a command to 90 characters and drops directory parts", () => {
    const guard = new LoopGuard(ON, () => undefined);
    guard.fold({}, { tool: "bash", target: `cd /Users/me/secret-project && ${"x".repeat(200)}` });
    guard.fold({ edits: ["/Users/me/secret-project/src/a.ts"] }, { tool: "edit", target: "/Users/me/secret-project/src/a.ts" });
    const digest = guard.digest();
    expect(digest).not.toContain("/Users");
    expect(digest).not.toContain("secret-project/");
    const [cmd, edit] = actions(digest);
    expect(cmd!.replace(/^\s*\d+: \$ /, "").length).toBeLessThanOrEqual(90);
    expect(edit).toContain("edit a.ts");
  });

  it("shows the error class and the counters, never output text", () => {
    const guard = new LoopGuard(ON, () => undefined);
    guard.fold({ errorClass: "TypeError", failure: SAME }, BASH);
    const digest = guard.digest();
    expect(digest).toContain("TypeError");
    expect(digest).toContain("turns=1 ");
    expect(digest).toContain("error_outputs=1");
  });

  it("tells the judge the envelope and the state of verification", () => {
    const guard = new LoopGuard(ON, () => undefined);
    guard.fold({ intent: "test", errorClass: "Error" }, BASH);
    guard.fold({ edits: ["a.ts"] }, { tool: "edit", target: "a.ts" });
    const digest = guard.digest();
    expect(digest).toContain("RESOLVE within ~10 calls");
    expect(digest).toContain("The last verification run failed. There have been edits since.");
  });
});

describe("LoopGuard failures", () => {
  it("never throws: an internal error becomes none", () => {
    const guard = new LoopGuard(ON, () => {
      throw new Error("sink broke");
    });
    const steps = Array.from({ length: 25 }, (_, i) => guard.fold(SIGNS[i] ?? {}, BASH));
    expect(steps.every((s) => s.kind === "none" || s.kind === "ask")).toBe(true);
    expect(() => guard.digest()).not.toThrow();
  });
});

describe("LoopGuard events", () => {
  it("writes a cause the host's schema takes, whatever the judge's choice label holds", () => {
    const { guard, events, run } = setup({ redirects: 0, backstopMult: 100 });
    run(20);
    guard.verdict({ stuck: true, confidence: 0.9, cause: `  <b>bold</b>\n${"x".repeat(200)}` });
    run(1);
    const stop = guardEvents(events, "stop")[0];
    expect(stop).toBeDefined();
    expect(EconomyGuardEvent.safeParse(stop!.payload).success).toBe(true);
  });

  it("writes only events the schema takes: the gate, the judge request, the redirect and the stop", () => {
    const { guard, events, run } = setup({ backstopMult: 100 });
    run(20);
    guard.verdict({ stuck: true, confidence: 0.9, cause: "repeating_failure" });
    run(2);
    for (const e of events.filter((x) => x.kind === "economy.guard")) expect(EconomyGuardEvent.safeParse(e.payload).success, JSON.stringify(e.payload)).toBe(true);
  });
});
