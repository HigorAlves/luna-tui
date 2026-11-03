// One credential loader per runtime, and the engine → loader map. A stage gets only its own
// engine's credential: a Claude stage never sees the Codex login, an eve stage never the Claude token.
import { type CredentialOwner, type EngineId, credentialOwner } from "@hardness/contracts";

import { claudeCredentials } from "./claude.ts";
import { codexCredentials } from "./codex.ts";
import type { Availability, CredentialLoader, CredentialOptions, PrepareWait, RunCredential } from "./credential.ts";
import { jevCredentials } from "./jev.ts";
import { openaiCredentials } from "./openai.ts";

export type { Availability, CredentialLoader, CredentialMount, CredentialOptions, PrepareWait, RunCredential } from "./credential.ts";
export { CredentialWaitError, NoCredentialError, noCredential } from "./credential.ts";
export { removeStaleCodexTemps } from "./codex.ts";

/** The loader for what `engine` needs: Claude's token, the Codex login, an OpenAI key or the Jev credential. */
export function credentialsFor(engine: EngineId, opts: CredentialOptions = {}): CredentialLoader {
  const loaders: Record<CredentialOwner, (opts: CredentialOptions) => CredentialLoader> = {
    claude: claudeCredentials,
    codex: codexCredentials,
    openai: openaiCredentials,
    typesafe: jevCredentials,
  };
  return loaders[credentialOwner(engine)](opts);
}

export interface CheckScope {
  repo?: string | null;
}

/** The machine's credentials by engine, as the stage runners and `GET /engines` use them. */
export interface Credentials {
  /** `scope.repo`: the repo the run is for, when the machine holds engines back per repo (its monthly caps). */
  check(engine: EngineId, scope?: CheckScope): Promise<Availability>;
  /** Waits, within `wait`, while another run holds a credential only one run may use at a time (the Codex login). */
  prepare(engine: EngineId, runDir: string, wait?: PrepareWait): Promise<RunCredential>;
}

export function machineCredentials(opts: CredentialOptions = {}): Credentials {
  return {
    check: (engine) => credentialsFor(engine, opts).check(),
    prepare: (engine, runDir, wait) => credentialsFor(engine, opts).prepare(runDir, wait),
  };
}

/** The same variables for every engine, nothing to release: tests and the sandbox smoke. */
export function fixedCredentials(env: Record<string, string>): Credentials {
  return {
    check: () => Promise.resolve({ available: true }),
    prepare: () => Promise.resolve({ env: { ...env }, mounts: [], release: async () => {} }),
  };
}
