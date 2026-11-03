// The model a compiled stage agent runs on, read when the server starts: the runner sets the
// engine's pinned ID and how it is paid in the server's environment, so one agent built at image
// time serves every engine on its runtime. A model instance keeps agent.ts loaded at run time
// ("A dynamic model or a model instance keeps agent.ts loaded at runtime", eve docs,
// agent-config.md, "Set the model").
import { chatgpt, openai } from "eve/models/openai";

import { secrets } from "./secrets.ts";

export function stageModel() {
  const id = process.env.LUNA_EVE_MODEL || undefined;
  if (process.env.LUNA_EVE_AUTH !== "api-key") return chatgpt(id);
  // openai() reads the key from the environment; it is set here, in this process only, so the
  // server's environ (what /proc shows) never held it.
  const key = secrets().openaiApiKey;
  if (key) process.env.OPENAI_API_KEY = key;
  return openai(id);
}
