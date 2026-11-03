// What holds an engine back on this machine besides its credential: a runtime turned off
// (MACHINE_DISABLE_RUNTIMES), a monthly cap reached (MACHINE_ENGINE_BUDGETS on the machine,
// luna.yaml `budget.engines` in a repo). A gate answers why an engine may not run, or null; the gated
// credentials say so through `check`, so the engine choice, the fallback after a usage limit,
// `POST /runs` and `GET /engines` all treat it like a missing credential, never silently.
import { basename } from "node:path";

import { type EngineBudgets, type EngineId, type RuntimeId, resolveEngine } from "@hardness/contracts";

import type { Availability, CheckScope, Credentials } from "../adapters/credentials/index.ts";
import { capsOn, monthStart, overCap } from "../domain/engine-budgets.ts";

export type Held = { code: "disabled" | "budget"; reason: string };

/** Why `engine` may not run on this machine right now (for a run in `scope.repo`), or null when nothing holds it. */
export type EngineGate = (engine: EngineId, scope?: CheckScope) => Promise<Held | null>;

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
    check: async (engine, scope): Promise<Availability> => {
      for (const gate of gates) {
        const held = await gate(engine, scope);
        if (held) return { available: false, code: held.code, reason: held.reason };
      }
      return credentials.check(engine, scope);
    },
    prepare: (engine, runDir, wait) => credentials.prepare(engine, runDir, wait),
  };
}

/** This calendar month's cost by engine, since a date: every run on the machine, or one repo's stage runs. */
export interface EngineSpend {
  engineSpendSinceUsd(since: Date, repo?: string): Promise<Map<string, number>>;
}

/** Holds an engine whose monthly cap is reached: the machine's (its own, or its credential's),
 *  then, for a run in a repo, that repo's luna.yaml caps against that repo's stage runs. */
export function engineBudgetGate(opts: { budgets: EngineBudgets; repoBudgets?: (repo: string) => Promise<EngineBudgets>; spend: EngineSpend }): EngineGate {
  // Spend is asked for only when a cap applies to the engine: most checks ask nothing of the database.
  const capped = (budgets: EngineBudgets, engine: EngineId) => capsOn(engine, budgets, new Map()).length > 0;
  return async (engine, scope) => {
    if (capped(opts.budgets, engine)) {
      const over = overCap(engine, opts.budgets, await opts.spend.engineSpendSinceUsd(monthStart()));
      if (over) return { code: "budget", reason: over };
    }
    const repo = scope?.repo;
    if (!repo || !opts.repoBudgets) return null;
    const budgets = await opts.repoBudgets(repo);
    if (!capped(budgets, engine)) return null;
    const over = overCap(engine, budgets, await opts.spend.engineSpendSinceUsd(monthStart(), repo), ` in ${basename(repo)}`);
    return over ? { code: "budget", reason: over } : null;
  };
}
