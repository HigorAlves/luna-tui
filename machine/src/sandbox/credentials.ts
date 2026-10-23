// Finds the Claude credential for stage containers. The value only ever travels in the
// docker process's environment; it is never logged or written to the run folder.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Credential {
  /** The environment variable Claude Code reads. */
  name: "CLAUDE_CODE_OAUTH_TOKEN" | "ANTHROPIC_API_KEY";
  value: string;
}

const SECRETS_DIR = join(homedir(), ".config", "hardness");

async function fromFile(file: string): Promise<string | null> {
  try {
    // Tokens never contain whitespace; a copy from a terminal can wrap them.
    const value = (await readFile(join(SECRETS_DIR, file), "utf8")).replace(/\s+/g, "");
    return value || null;
  } catch {
    return null;
  }
}

/** Subscription token first, then API key; environment variables win over files. */
export async function loadCredential(env = process.env): Promise<Credential | null> {
  if (env.CLAUDE_CODE_OAUTH_TOKEN) return { name: "CLAUDE_CODE_OAUTH_TOKEN", value: env.CLAUDE_CODE_OAUTH_TOKEN };
  if (env.ANTHROPIC_API_KEY) return { name: "ANTHROPIC_API_KEY", value: env.ANTHROPIC_API_KEY };
  const token = await fromFile("claude-oauth-token");
  if (token) return { name: "CLAUDE_CODE_OAUTH_TOKEN", value: token };
  const key = await fromFile("anthropic-api-key");
  if (key) return { name: "ANTHROPIC_API_KEY", value: key };
  return null;
}
