// What `GET /engines` says about each engine: the catalog's facts, whether this machine can run it
// (the caller asks the gated credentials) and its month's spend against its cap. Pure.
import { ENGINES, type Engine, type EngineId, type EngineInfo, MODELS } from "@hardness/contracts";

export function engineInfo(
  id: EngineId,
  availability: { available: boolean; reason?: string },
  standing: { spentThisMonthUsd: number; budgetUsd: number | null } = { spentThisMonthUsd: 0, budgetUsd: null },
): EngineInfo {
  const engine: Engine = ENGINES[id];
  const model = MODELS[engine.model];
  return {
    id,
    runtime: model.runtime,
    modelId: model.id,
    // An engine that names no auth pays the runtime's own way: Claude's subscription first, Jev's API key.
    auth: engine.auth ?? (model.runtime === "claude" ? "subscription" : "api-key"),
    status: model.status,
    available: availability.available,
    ...(availability.available ? {} : { reason: availability.reason }),
    spentThisMonthUsd: standing.spentThisMonthUsd,
    budgetUsd: standing.budgetUsd,
  };
}
