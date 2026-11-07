// What `pnpm start` writes to `~/.config/hardness/cognee.env`, the env file of the Cognee service (RFC 0007). Pure: it is handed the
// catalog's models and the secrets, so it imports nothing and a script at the repository root can run it. No model ID is written in
// compose.yaml: the LLM and the embedder come from the catalog (`contracts/src/models.ts`, `SERVICE_MODELS.cognee`).

export interface CogneeModels {
  llm: { id: string };
  embedder: { id: string };
  service: { dimensions: number; llmProvider: string; embeddingProvider: string };
}

export interface CogneeEnvInput {
  models: CogneeModels;
  /** Signs the machine user's tokens: without it every token dies when the container restarts. */
  jwtSecret: string;
  /** Cognee's own OpenAI key; absent means local mode (Cognee builds its graph with its local extractor). */
  openaiKey: string | null;
}

/** The variables, in the order the file lists them. A value never holds a newline. */
export function cogneeEnv(input: CogneeEnvInput): Array<[string, string]> {
  const { models, jwtSecret, openaiKey } = input;
  const clean = (value: string): string => value.replace(/[\r\n]/g, "");
  return [
    // With a key Cognee extracts with OpenAI; without one it runs keyless (GLiNER), so none of these is written.
    ...(openaiKey ? ([["LLM_PROVIDER", models.service.llmProvider], ["LLM_MODEL", `${models.service.llmProvider}/${models.llm.id}`], ["LLM_API_KEY", clean(openaiKey)]] as Array<[string, string]>) : []),
    // Set explicitly: with a key present Cognee would otherwise embed with OpenAI, and search must never call it.
    ["EMBEDDING_PROVIDER", models.service.embeddingProvider],
    ["EMBEDDING_MODEL", models.embedder.id],
    ["EMBEDDING_DIMENSIONS", String(models.service.dimensions)],
    ["FASTAPI_USERS_JWT_SECRET", clean(jwtSecret)],
    ["AUTO_FEEDBACK", "false"],
    // The image runs as uid 1000 and only /cognee-storage is writable by it.
    ["HF_HOME", "/cognee-storage/models/hf"],
    ["FASTEMBED_CACHE_PATH", "/cognee-storage/models/fastembed"],
  ];
}

/** The file's text. */
export function renderCogneeEnv(input: CogneeEnvInput): string {
  const header = `# Written by \`pnpm start\` from the model catalog and ~/.config/hardness/cognee-*; edit those, not this file.\n# Mode: ${input.openaiKey ? "openai (Cognee has its own key)" : "local (no cognee-openai-key)"}\n`;
  return header + cogneeEnv(input).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
}
