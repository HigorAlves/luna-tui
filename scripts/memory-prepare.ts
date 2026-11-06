// `pnpm start` runs this before compose: it makes the memory service's secrets on first start (mode 600, in ~/.config/hardness), and renders
// ~/.config/hardness/cognee.env from the model catalog (RFC 0007). Idempotent: the secrets are made once, the env file is rewritten each time
// so a key you add or remove (cognee-openai-key) takes effect at the next start. It also makes the code graph's folder as you, so Docker
// does not make it as root. Prints no secret.
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { renderCogneeEnv } from "../machine/src/bootstrap/cognee-env.ts";
import { MODELS, SERVICE_MODELS } from "../contracts/src/models.ts";

const home = process.env.HOME ?? homedir();
const dir = process.env.HARDNESS_CONFIG_DIR ?? join(home, ".config", "hardness");
mkdirSync(dir, { recursive: true, mode: 0o700 });

const read = (name: string): string | null => {
  try {
    return readFileSync(join(dir, name), "utf8").replace(/\s+/g, "") || null;
  } catch {
    return null;
  }
};
const write = (name: string, text: string): void => {
  const path = join(dir, name);
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
};
const made = (name: string): string => {
  const existing = read(name);
  if (existing) return existing;
  const value = randomBytes(32).toString("hex");
  write(name, `${value}\n`);
  return value;
};

made("cognee-password");
const jwtSecret = made("cognee-jwt-secret");
const openaiKey = read("cognee-openai-key");
const service = SERVICE_MODELS.cognee;
write("cognee.env", renderCogneeEnv({ models: { llm: MODELS[service.llm], embedder: MODELS[service.embedder], service }, jwtSecret, openaiKey }));

const state = process.env.MACHINE_STATE_DIR ?? join(home, ".local", "state", "hardness");
const code = join(state, "memory", "code");
if (!existsSync(code)) mkdirSync(code, { recursive: true });
console.log(`memory: cognee.env written (${openaiKey ? "openai mode: Cognee has its own key" : "local mode: no ~/.config/hardness/cognee-openai-key"})`);
