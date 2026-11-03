// What `GET /engines` says about each engine: the catalog's facts, and whether this machine has
// its credential (the caller asks the credential loaders). Pure.
import { ENGINES, type Engine, type EngineId, type EngineInfo, MODELS } from "@hardness/contracts";

export function engineInfo(id: EngineId, availability: { available: boolean; reason?: string }): EngineInfo {
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
  };
}
