// The economy session: what a runtime learns from one finished tool call, and that it never breaks the run.
import { LOOP_STUCK, type EconomyInput, type GuardInput, type RunEvent } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import { type JudgePort, economySession } from "./session.ts";

const GUARD: GuardInput = { mode: "on", judge: true, envelope: 4, judgeConfidence: 0.7, redirects: 1, backstopMult: 2 };
const FAIL = { id: "t", tool: "Bash", input: { command: "pnpm test" }, output: "AssertionError: expected 1 to be 2", ok: false };
const EDIT = { id: "e", tool: "Edit", input: { file_path: "/work/src/a.ts" }, output: "", ok: true };

function setup(economy: EconomyInput | undefined, judge?: JudgePort | null) {
  const events: RunEvent[] = [];
  const session = economySession({ economy, work: "/work", emit: (e) => events.push(e), judge });
  return { events, session };
}

/** Calls until the guard says something other than none, at most `max` calls. */
function until(session: NonNullable<ReturnType<typeof setup>["session"]>, max = 80) {
  for (let i = 0; i < max; i++) {
    const { step } = session.settled(i % 2 === 0 ? FAIL : EDIT);
    if (step.kind !== "none") return { step, calls: i + 1 };
  }
  return null;
}

describe("economySession", () => {
  it("is null without economy input", () => {
    expect(setup(undefined).session).toBeNull();
  });

  it("observes without a guard and never steps", () => {
    const { session, events } = setup({});
    const r = session!.settled(FAIL);
    expect(r.step).toEqual({ kind: "none" });
    expect(r.observation).toMatchObject({ intent: "test" });
    expect(events).toEqual([]);
  });

  it("never puts the output text in what it returns", () => {
    const { session } = setup({ guard: GUARD });
    const r = session!.settled({ ...FAIL, output: "AssertionError: token sk-secret-123 leaked" });
    expect(JSON.stringify(r)).not.toContain("sk-secret-123");
  });

  it("redirects once, then stops with the loop-stuck reason", () => {
    const { session, events } = setup({ guard: { ...GUARD, judge: false } });
    const first = until(session!);
    expect(first?.step.kind).toBe("redirect");
    const second = until(session!);
    expect(second?.step).toMatchObject({ kind: "stop", reason: expect.stringContaining(LOOP_STUCK) });
    expect(events.filter((e) => e.kind === "economy.guard").map((e) => e.payload.action)).toContain("stop");
  });

  it("hands an ask to the judge port and tells the runtime nothing, then applies its verdict", () => {
    const asked: string[] = [];
    let answer: ReturnType<JudgePort["poll"]> = null;
    const judge: JudgePort = { ask: (d) => void asked.push(d), poll: () => answer };
    const { session } = setup({ guard: { ...GUARD, envelope: 1000 } }, judge);
    let calls = 0;
    while (asked.length === 0 && calls < 60) {
      expect(session!.settled(calls % 2 === 0 ? FAIL : EDIT).step.kind).toBe("none");
      calls++;
    }
    expect(asked).toHaveLength(1);
    answer = { stuck: true, confidence: 0.95, cause: "same failure" };
    expect(session!.settled(FAIL).step.kind).toBe("redirect");
  });

  it("asks again after the judge reports the answer expired", () => {
    const asked: string[] = [];
    let answer: ReturnType<JudgePort["poll"]> = null;
    const judge: JudgePort = { ask: (d) => void asked.push(d), poll: () => answer };
    const { session } = setup({ guard: { ...GUARD, envelope: 1000 } }, judge);
    for (let i = 0; asked.length === 0 && i < 60; i++) session!.settled(i % 2 === 0 ? FAIL : EDIT);
    for (let i = 0; i < 10; i++) session!.settled(FAIL);
    expect(asked).toHaveLength(1);
    answer = "expired";
    session!.settled(FAIL);
    answer = null;
    for (let i = 0; i < 6; i++) session!.settled(FAIL);
    expect(asked).toHaveLength(2);
  });

  it("observes a subagent's call but never folds it into the guard", () => {
    const { session, events } = setup({ guard: { ...GUARD, judge: false, envelope: 4 } });
    for (let i = 0; i < 80; i++) {
      const r = session!.settled({ ...(i % 2 === 0 ? FAIL : EDIT), subagent: true });
      expect(r.step).toEqual({ kind: "none" });
      expect(r.observation).toBeDefined();
    }
    expect(events).toEqual([]);
    // The main thread's count starts from nothing: the subagent's 80 calls were not its own.
    expect(until(session!, 15)).toBeNull();
  });

  it("with no judge port an ask is dropped and the run goes on", () => {
    const { session } = setup({ guard: { ...GUARD, envelope: 1000 } });
    for (let i = 0; i < 60; i++) expect(session!.settled(i % 2 === 0 ? FAIL : EDIT).step.kind).toBe("none");
  });

  it("reports a throw as one economy_error note and goes on", () => {
    const { session, events } = setup({ guard: GUARD });
    const hostile = { id: "x", tool: "Bash", input: {}, get output(): string { throw new Error("boom"); }, ok: true } as never;
    expect(session!.settled(hostile)).toEqual({ observation: undefined, step: { kind: "none" } });
    expect(session!.settled(hostile)).toEqual({ observation: undefined, step: { kind: "none" } });
    expect(events).toEqual([{ kind: "note", payload: { phase: "economy_error", message: "boom" } }]);
    expect(session!.settled(FAIL).observation).toMatchObject({ intent: "test" });
  });

  it("a judge port that throws is the same error path", () => {
    const judge: JudgePort = { ask: () => undefined, poll: () => { throw new Error("mailbox gone"); } };
    const { session, events } = setup({ guard: GUARD }, judge);
    expect(session!.settled(FAIL).step).toEqual({ kind: "none" });
    expect(events).toEqual([{ kind: "note", payload: { phase: "economy_error", message: "mailbox gone" } }]);
  });
});
