// The model a compiled stage agent runs on, read when the server starts: the runner sets the
// engine's pinned ID and how it is paid in the server's environment, so one agent built at image
// time serves every engine on its runtime. A model instance keeps agent.ts loaded at run time
// ("A dynamic model or a model instance keeps agent.ts loaded at runtime", eve docs,
// agent-config.md, "Set the model").
import { ENGINES, type EngineId, resolveEngine } from "@hardness/contracts";
import { chatgpt, openai } from "eve/models/openai";

import { secrets } from "./secrets.ts";

export function stageModel() {
  return modelOf(process.env.LUNA_EVE_MODEL || undefined, process.env.LUNA_EVE_AUTH === "api-key");
}

/** The model of a subagent's own engine, which is not the stage's: the engine's pinned ID, on the
 *  ChatGPT login or the OpenAI key as the catalog says. Only an eve engine has one. */
export function engineModel(engine: EngineId) {
  const resolved = resolveEngine(engine);
  if (resolved.runtime !== "eve") throw new Error(`${engine} does not run on eve`);
  return modelOf(resolved.modelId, (ENGINES[engine] as { auth?: string }).auth === "api-key");
}

function modelOf(id: string | undefined, apiKey: boolean) {
  if (!apiKey) return chatgpt(id);
  // openai() reads the key from the environment; it is set here, in this process only, so the
  // server's environ (what /proc shows) never held it.
  const key = secrets().openaiApiKey;
  if (key) process.env.OPENAI_API_KEY = key;
  return openai(id);
}
