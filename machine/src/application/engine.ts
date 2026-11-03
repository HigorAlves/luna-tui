// The engine a pack runs on, here: the pure choice (domain/engine-choice.ts) told which of the
// engines asked for this machine has no credential for, or holds back (a runtime turned off).
// Only the engines asked for are checked.
import type { EngineId, Pack, StageEngines } from "@hardness/contracts";

import type { Credentials } from "../adapters/credentials/index.ts";
import { type EngineChoice, chooseEngine } from "../domain/engine-choice.ts";

export async function pickEngine(
  credentials: Pick<Credentials, "check">,
  pack: Pick<Pack, "id" | "engines">,
  task: StageEngines | null,
  config: StageEngines | null,
  /** The repo the run is for: its luna.yaml may cap an engine there. */
  repo: string | null = null,
): Promise<EngineChoice> {
  const missing = new Map<EngineId, string>();
  const held = new Map<EngineId, string>();
  for (const engine of new Set([task?.[pack.id], config?.[pack.id]])) {
    if (!engine || engine === pack.engines.default) continue;
    const found = await credentials.check(engine, { repo });
    if (!found.available) (found.code ? held : missing).set(engine, found.reason);
  }
  return chooseEngine({ pack, task, config, missing: (engine) => missing.get(engine) ?? null, unavailable: (engine) => held.get(engine) ?? null });
}
