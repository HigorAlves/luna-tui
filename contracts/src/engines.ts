// Engines: the names packs, luna.yaml and the boards use for "what runs this". An engine is a
// catalog model (./models.ts) plus how it is paid for; its runtime is the catalog entry's.
// Effort is not here: it is about the job, so the pack sets it. See RFC 0002.
import { z } from "zod";

import { MODELS, type ModelEntry, type ModelKey, type RuntimeId } from "./models.ts";

export interface Engine {
  model: ModelKey;
  /** The credential the run needs; absent means the runtime's own (Claude: the subscription token first). */
  auth?: "subscription" | "chatgpt" | "api-key";
}

export const ENGINES = {
  "claude:opus": { model: "anthropic/opus-5.5" },
  "claude:sonnet": { model: "anthropic/sonnet-5.5" },
  "claude:haiku": { model: "anthropic/haiku-5.5" },
  // The same OpenAI models twice: on the Codex (ChatGPT) login, and on an OpenAI API key.
  "codex:sol": { model: "openai/gpt-5.6-terra", auth: "chatgpt" },
  "codex:luna": { model: "openai/gpt-6-luna", auth: "chatgpt" },
  "openai:sol": { model: "openai/gpt-6-sol", auth: "api-key" },
  "openai:luna": { model: "openai/gpt-6-luna", auth: "api-key" },
  jev: { model: "typesafe/jev" },
} as const satisfies Record<string, Engine>;

export const EngineId = z.enum(Object.keys(ENGINES) as [keyof typeof ENGINES, ...(keyof typeof ENGINES)[]]);
export type EngineId = z.infer<typeof EngineId>;

export interface ResolvedEngine {
  id: EngineId;
  runtime: RuntimeId;
  /** The pinned ID the runtime passes to its SDK. */
  modelId: string;
  caps: ModelEntry["caps"];
}

export function resolveEngine(id: EngineId): ResolvedEngine {
  const model = MODELS[ENGINES[id].model];
  return { id, runtime: model.runtime, modelId: model.id, caps: model.caps };
}

/** Whose credential an engine spends, and so whose usage window it shares: a ChatGPT limit on
 *  the Codex login never stops a Claude stage, nor the other way round. */
export type CredentialOwner = "claude" | "codex" | "openai" | "typesafe";

export function credentialOwner(id: EngineId): CredentialOwner {
  const { runtime } = resolveEngine(id);
  if (runtime === "claude") return "claude";
  if (runtime === "jev") return "typesafe";
  return (ENGINES[id] as Engine).auth === "chatgpt" ? "codex" : "openai";
}
