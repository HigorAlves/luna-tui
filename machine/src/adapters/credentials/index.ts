// One credential loader per runtime, and the engine → loader map. A stage gets only its own
// engine's credential: a Claude stage never sees the Codex login, an eve stage never the Claude token.
import { ENGINES, type Engine, type EngineId, resolveEngine } from "@hardness/contracts";

import { claudeCredentials } from "./claude.ts";
import { codexCredentials } from "./codex.ts";
import { type Availability, type CredentialLoader, type CredentialOptions, type RunCredential, noCredential } from "./credential.ts";
import { openaiCredentials } from "./openai.ts";
import { typesafeCredentials } from "./typesafe.ts";

export type { Availability, CredentialLoader, CredentialMount, CredentialOptions, RunCredential } from "./credential.ts";
export { NoCredentialError, noCredential } from "./credential.ts";

/** The loader for what `engine` needs: Claude's token, the Codex login, an OpenAI key or a TypeSafe key. */
export function credentialsFor(engine: EngineId, opts: CredentialOptions = {}): CredentialLoader {
  const { runtime } = resolveEngine(engine);
  const { auth }: Engine = ENGINES[engine];
  if (runtime === "claude") return claudeCredentials(opts);
  if (runtime === "jev") return typesafeCredentials(opts);
  if (auth === "chatgpt") return codexCredentials(opts);
  if (auth === "api-key") return openaiCredentials(opts);
  return noCredential(`${engine}: no credential loader for its runtime`);
}

/** The machine's credentials by engine, as the stage runners and `GET /engines` use them. */
export interface Credentials {
  check(engine: EngineId): Promise<Availability>;
  prepare(engine: EngineId, runDir: string): Promise<RunCredential>;
}

export function machineCredentials(opts: CredentialOptions = {}): Credentials {
  return {
    check: (engine) => credentialsFor(engine, opts).check(),
    prepare: (engine, runDir) => credentialsFor(engine, opts).prepare(runDir),
  };
}

/** The same variables for every engine, nothing to release: tests and the sandbox smoke. */
export function fixedCredentials(env: Record<string, string>): Credentials {
  return {
    check: () => Promise.resolve({ available: true }),
    prepare: () => Promise.resolve({ env: { ...env }, mounts: [], release: async () => {} }),
  };
}
