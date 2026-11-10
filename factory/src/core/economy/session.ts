// What a runtime does with each finished tool call under the token economy (RFC 0007 §1, §2): read the
// result into an Observation, fold it into the loop guard, and say what happens next. Both runtimes
// drive it the same way; they differ only in how a redirect reaches the model and how a run is ended.
// It never throws: a fault in the economy is one note in the run's events, and the run goes on as it
// would without it.
import type { EconomyInput, Observation, RunEvent } from "@hardness/contracts";

import { callTarget } from "../render.ts";
import { LoopGuard, type GuardStep, type Verdict } from "./guard.ts";
import { observe } from "./observe.ts";

/** Where the guard's question goes; the answer comes back later, or never. */
export interface JudgePort {
  ask(digest: string): void;
  /** The verdict that has come, "expired" when the outstanding ask will never be answered, else null. */
  poll(): Verdict | "expired" | null;
}

export interface EconomySession {
  /** One finished tool call: its observation (for the tool_result event) and what the runtime does next. Never throws. */
  settled(call: { id: string; tool: string; input: unknown; output: string; ok: boolean }): { observation: Observation | undefined; step: GuardStep };
}

const NONE: GuardStep = { kind: "none" };

/** The session for a run, or null when the machine sent no economy input: the run is then as it was. */
export function economySession(o: { economy: EconomyInput | undefined; work: string; emit: (e: RunEvent) => void; judge?: JudgePort | null }): EconomySession | null {
  if (!o.economy) return null;
  const guard = o.economy.guard ? new LoopGuard(o.economy.guard, o.emit) : null;
  let reported = false;
  return {
    settled(call) {
      try {
        const observation = observe(call, { work: o.work });
        if (!guard) return { observation, step: NONE };
        const verdict = o.judge?.poll();
        if (verdict === "expired") guard.expire();
        else if (verdict) guard.verdict(verdict);
        const asObject = typeof call.input === "object" && call.input !== null ? (call.input as Record<string, unknown>) : {};
        const step = guard.fold(observation, { tool: call.tool, target: callTarget(call.tool, asObject).target });
        if (step.kind !== "ask") return { observation, step };
        // No judge port: the question goes nowhere and the guard keeps its backstop.
        o.judge?.ask(step.digest);
        return { observation, step: NONE };
      } catch (e) {
        if (!reported) {
          reported = true;
          o.emit({ kind: "note", payload: { phase: "economy_error", message: e instanceof Error ? e.message : String(e) } });
        }
        return { observation: undefined, step: NONE };
      }
    },
  };
}
