// Finds the Claude credential for stage containers. It is never logged. With the relay (`engineRelay`) the stage never
// holds it: it is a file only the egress proxy mounts, and the stage gets a placeholder. Without, it is the stage's own
// secret file, as for every other engine.
import { randomBytes } from "node:crypto";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { type CredentialLoader, type CredentialOptions, type EngineRelay, NoCredentialError, type RunCredential, secretFile, secretsDir } from "./credential.ts";

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

/** The relayed credential: the real value in `<runDir>/relay/anthropic` (a 0700 folder, a 0444 file, so the proxy's user reads it once the file is mounted alone), and a placeholder with the same prefix (`sk-ant-oat01-`, `sk-ant-api03-`) and a random tail in its place. */
async function relayed(credential: Credential, runDir: string): Promise<RunCredential> {
  const oauth = credential.name === "CLAUDE_CODE_OAUTH_TOKEN";
  const placeholder = `${oauth ? "sk-ant-oat01-" : "sk-ant-api03-"}luna-relay-${randomBytes(16).toString("hex")}`;
  const dir = join(runDir, "relay");
  const file = join(dir, "anthropic");
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(file, credential.value, { mode: 0o444 });
  await chmod(file, 0o444);
  const kind = oauth ? "oauth" : "api-key";
  const metaFile = join(dir, "meta.json");
  await writeFile(metaFile, JSON.stringify({ kind, placeholder }), { mode: 0o444 });
  await chmod(metaFile, 0o444);
  const relay: EngineRelay = { kind, placeholder, file, metaFile };
  return { env: { [credential.name]: placeholder }, mounts: [], relay, release: () => rm(dir, { recursive: true, force: true }) };
}

/** The `claude` runtime's loader: the one variable Claude Code reads, nothing else. */
export function claudeCredentials(opts: CredentialOptions = {}): CredentialLoader {
  const load = () => loadCredential(opts.env ?? process.env, secretsDir(opts.home ?? homedir()));
  return {
    async check() {
      return (await load()) ? { available: true } : { available: false, reason: NO_CLAUDE };
    },
    async prepare(runDir) {
      const credential = await load();
      if (!credential) throw new NoCredentialError(NO_CLAUDE);
      if (opts.engineRelay) return relayed(credential, runDir);
      return { env: { [credential.name]: credential.value }, mounts: [], release: async () => {} };
    },
  };
}
