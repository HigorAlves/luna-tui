// What holds an engine back on this machine besides its credential: a runtime turned off
// (MACHINE_DISABLE_RUNTIMES). A gate answers why an engine may not run, or null; the gated
// credentials say so through `check`, so the engine choice, the fallback after a usage limit,
// `POST /runs` and `GET /engines` all treat it like a missing credential, never silently.
import { type EngineId, type RuntimeId, resolveEngine } from "@hardness/contracts";

import type { Availability, Credentials } from "../adapters/credentials/index.ts";

export type Held = { code: "disabled" | "budget"; reason: string };

/** Why `engine` may not run on this machine right now, or null when nothing holds it. */
export type EngineGate = (engine: EngineId) => Promise<Held | null>;

/** What `GET /engines` and a task's note say about an engine on a runtime that is turned off. */
export const DISABLED_REASON = "disabled by MACHINE_DISABLE_RUNTIMES";

/** Holds every engine whose runtime is in `disabled`. Read at boot: a restart applies a change. */
export function runtimeKillSwitch(disabled: readonly RuntimeId[]): EngineGate {
  const off = new Set(disabled);
  return async (engine) => (off.has(resolveEngine(engine).runtime) ? { code: "disabled", reason: DISABLED_REASON } : null);
}

/** The credentials as the machine uses them: an engine a gate holds is unavailable with the gate's
 *  reason, before its credential is looked at. `prepare` is the inner one's: the choice already
 *  kept a held engine from running. */
export function gatedCredentials(credentials: Credentials, gates: EngineGate[]): Credentials {
  return {
    check: async (engine): Promise<Availability> => {
      for (const gate of gates) {
        const held = await gate(engine);
        if (held) return { available: false, code: held.code, reason: held.reason };
      }
      return credentials.check(engine);
    },
    prepare: (engine, runDir, wait) => credentials.prepare(engine, runDir, wait),
  };
}
