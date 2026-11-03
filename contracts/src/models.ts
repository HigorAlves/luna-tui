// The model catalog: the only file in the repo that names a provider's model ID. Engines
// (./engines.ts) name a catalog key; a pinned ID only changes here, so a model never drifts
// under an alias and an upgrade is one reviewed line. See RFC 0003.

/** The harness that runs a model, one per vendor SDK: factory/src/runtimes/<runtime>/. */
export type RuntimeId = "claude" | "eve" | "jev";

/** How hard the model thinks: the pack asks for one, the model must support it. */
export type Effort = "low" | "medium" | "high";

export interface ModelEntry {
  runtime: RuntimeId;
  /** The exact ID the vendor SDK takes. */
  id: string;
  status: "preview" | "ga" | "deprecated";
  /** A deprecated model may still run until this date (YYYY-MM-DD), not after. */
  retireAfter?: string;
  /** The same model on the Vercel AI Gateway, when it is served there: the ID the AI SDK takes. */
  gatewayId?: string;
  /** What a call costs, when the vendor reports no cost of its own; the only place a price lives. */
  pricing?: { inputPerMTokUsd: number; outputPerMTokUsd?: number };
  caps: {
    /** It can call tools, so it can run an agent pack. */
    tools: boolean;
    /** It can answer through a JSON schema. */
    structured: boolean;
    effort: Effort[];
  };
}

const ALL_EFFORTS: Effort[] = ["low", "medium", "high"];
const AGENT = { tools: true, structured: true, effort: ALL_EFFORTS };

const CATALOG = {
  "anthropic/opus-5.5": { runtime: "claude", id: "claude-opus-5-5", status: "ga", caps: AGENT },
  "anthropic/sonnet-5.5": { runtime: "claude", id: "claude-sonnet-5-5", status: "ga", caps: AGENT },
  "anthropic/haiku-5.5": { runtime: "claude", id: "claude-haiku-5-5", status: "ga", caps: AGENT },
  "openai/gpt-6-sol": { runtime: "eve", id: "gpt-6-sol", status: "preview", caps: AGENT },
  "openai/gpt-6-luna": { runtime: "eve", id: "gpt-6-luna-fast", status: "preview", caps: AGENT },
  // What a ChatGPT (Codex) login serves for the stronger engine: gpt-6-sol is API-only on it.
  "openai/gpt-5.6-terra": { runtime: "eve", id: "gpt-5.6-terra", status: "preview", caps: AGENT },
  // A decision model: typed answers to typed questions, no tools and no effort setting. Billed per
  // input token only, through TypeSafe's API or the Vercel AI Gateway alike.
  "typesafe/jev": {
    runtime: "jev",
    id: "jev-latest",
    gatewayId: "typesafe-ai/jev",
    pricing: { inputPerMTokUsd: 0.042 },
    status: "preview",
    caps: { tools: false, structured: true, effort: [] },
  },
} as const satisfies Record<string, ModelEntry>;
export type ModelKey = keyof typeof CATALOG;
export const MODELS: Record<ModelKey, ModelEntry> = CATALOG;

/** Whether a model is past its retirement on `today` (YYYY-MM-DD): deprecated, and after retireAfter. */
export function retired(model: ModelEntry, today: string): boolean {
  return model.status === "deprecated" && model.retireAfter !== undefined && today > model.retireAfter;
}
