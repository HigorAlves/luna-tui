import { MODELS, SERVICE_MODELS } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import { renderCogneeEnv } from "./cognee-env.ts";

const models = { llm: MODELS[SERVICE_MODELS.cognee.llm], embedder: MODELS[SERVICE_MODELS.cognee.embedder], service: SERVICE_MODELS.cognee };
const parse = (text: string): Record<string, string> => Object.fromEntries(text.split("\n").filter((l) => l && !l.startsWith("#")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));

describe("renderCogneeEnv", () => {
  it("renders the LLM and key from the catalog when Cognee has its own key, with local embeddings set explicitly", () => {
    const env = parse(renderCogneeEnv({ models, jwtSecret: "j".repeat(64), openaiKey: "sk-test-1234567890\n" }));
    expect(env).toEqual({
      LLM_PROVIDER: "openai",
      LLM_MODEL: `openai/${MODELS[SERVICE_MODELS.cognee.llm].id}`,
      LLM_API_KEY: "sk-test-1234567890",
      EMBEDDING_PROVIDER: "fastembed",
      EMBEDDING_MODEL: "BAAI/bge-small-en-v1.5",
      EMBEDDING_DIMENSIONS: "384",
      FASTAPI_USERS_JWT_SECRET: "j".repeat(64),
      AUTO_FEEDBACK: "false",
      HF_HOME: "/cognee-storage/models/hf",
      FASTEMBED_CACHE_PATH: "/cognee-storage/models/fastembed",
    });
  });

  it("writes no LLM variable without a key (local mode) and keeps the embedder", () => {
    const text = renderCogneeEnv({ models, jwtSecret: "secret", openaiKey: null });
    expect(text).not.toMatch(/LLM_/);
    expect(text).toMatch(/local \(no cognee-openai-key\)/);
    expect(parse(text).EMBEDDING_PROVIDER).toBe("fastembed");
  });

  it("never lets a value start another line", () => {
    const env = parse(renderCogneeEnv({ models, jwtSecret: "a\nB=1", openaiKey: "k\rX=2" }));
    expect(env.B).toBeUndefined();
    expect(env.X).toBeUndefined();
  });
});
