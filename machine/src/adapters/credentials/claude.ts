// Finds the Claude credential for stage containers. The value only ever travels in the
// docker process's environment; it is never logged or written to the run folder.
import { homedir } from "node:os";

import { type CredentialLoader, type CredentialOptions, NoCredentialError, secretFile, secretsDir } from "./credential.ts";

export interface Credential {
  /** The environment variable Claude Code reads. */
  name: "CLAUDE_CODE_OAUTH_TOKEN" | "ANTHROPIC_API_KEY";
  value: string;
}

const NO_CLAUDE = "no Claude credential: set CLAUDE_CODE_OAUTH_TOKEN (or ANTHROPIC_API_KEY), or put claude-oauth-token in ~/.config/hardness";

/** Subscription token first, then API key; environment variables win over files. */
export async function loadCredential(env = process.env, dir = secretsDir(homedir())): Promise<Credential | null> {
  if (env.CLAUDE_CODE_OAUTH_TOKEN) return { name: "CLAUDE_CODE_OAUTH_TOKEN", value: env.CLAUDE_CODE_OAUTH_TOKEN };
  if (env.ANTHROPIC_API_KEY) return { name: "ANTHROPIC_API_KEY", value: env.ANTHROPIC_API_KEY };
  const token = await secretFile(dir, "claude-oauth-token");
  if (token) return { name: "CLAUDE_CODE_OAUTH_TOKEN", value: token };
  const key = await secretFile(dir, "anthropic-api-key");
  if (key) return { name: "ANTHROPIC_API_KEY", value: key };
  return null;
}

/** The `claude` runtime's loader: the one variable Claude Code reads, nothing else. */
export function claudeCredentials(opts: CredentialOptions = {}): CredentialLoader {
  const load = () => loadCredential(opts.env ?? process.env, secretsDir(opts.home ?? homedir()));
  return {
    async check() {
      return (await load()) ? { available: true } : { available: false, reason: NO_CLAUDE };
    },
    async prepare() {
      const credential = await load();
      if (!credential) throw new NoCredentialError(NO_CLAUDE);
      return { env: { [credential.name]: credential.value }, mounts: [], release: async () => {} };
    },
  };
}
