// The run's secrets inside the eve server: the API password, the luna bridge's token, the GitHub
// token for `gh` and an OpenAI key, read once from the 0600 file the runner names in
// LUNA_EVE_SECRETS. Never the environment: a process's environ outlives any later change to it in
// /proc, and the file is outside every root a tool may name (core/roots.ts).
import { readFileSync } from "node:fs";

export interface EveSecrets {
  password: string;
  bridgeToken: string;
  ghToken?: string;
  openaiApiKey?: string;
}

let cached: EveSecrets | undefined;

/** The secrets; without a readable file, a random password nobody knows and no tokens. */
export function secrets(): EveSecrets {
  if (cached === undefined) {
    try {
      cached = JSON.parse(readFileSync(process.env.LUNA_EVE_SECRETS ?? "", "utf8")) as EveSecrets;
    } catch {
      cached = { password: crypto.randomUUID(), bridgeToken: "" };
    }
  }
  return cached;
}
