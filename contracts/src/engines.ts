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

const METERED_OWNERS: readonly CredentialOwner[] = ["codex", "openai", "typesafe"];

/** Why `key` cannot name a monthly cap (MACHINE_ENGINE_BUDGETS, luna.yaml `budget.engines`), or
 *  null: a cap names an engine or a credential, whose engines it then counts together. Claude has
 *  none: every pack's default runs on it, so a spent cap would leave no engine to run. */
export function engineBudgetKeyProblem(key: string): string | null {
  if (key === "claude" || key.startsWith("claude:")) return `${key}: no monthly cap on Claude, every pack's default runs on it (use policy.monthly_budget_usd or MACHINE_DAILY_BUDGET_USD)`;
  if (key in ENGINES || (METERED_OWNERS as string[]).includes(key)) return null;
  return `${key}: not an engine or a credential (${METERED_OWNERS.join(", ")})`;
}

/** Monthly caps in USD by engine (`openai:sol`) or credential (`openai`); 0 holds an engine once it has cost anything. */
export const EngineBudgets = z.record(z.string(), z.number().nonnegative()).superRefine((caps, ctx) => {
  for (const key of Object.keys(caps)) {
    const problem = engineBudgetKeyProblem(key);
    if (problem) ctx.addIssue({ code: "custom", path: [key], message: problem });
  }
});
export type EngineBudgets = z.infer<typeof EngineBudgets>;
