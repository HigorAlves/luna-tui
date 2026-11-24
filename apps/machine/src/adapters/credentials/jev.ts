// The Jev credential for the `jev` engine: opt-in and metered; without it nothing classifies. Jev
// is reached two ways, and the key found first decides which: the Vercel AI Gateway's key, then
// TypeSafe's own. A run gets the one key, by its variable's name, as every credential is passed.
import { homedir } from "node:os";

import { type CredentialLoader, type CredentialOptions, NoCredentialError, apiKeyCredentials } from "./credential.ts";

const MISSING =
  "no Jev credential: set AI_GATEWAY_API_KEY or put it in ~/.config/hardness/ai-gateway-api-key (the Vercel AI Gateway), or set TYPESAFE_API_KEY or put it in ~/.config/hardness/typesafe-api-key";

/** `AI_GATEWAY_API_KEY`, else `~/.config/hardness/ai-gateway-api-key`, else `TYPESAFE_API_KEY`, else `~/.config/hardness/typesafe-api-key`. */
export function jevCredentials(opts: CredentialOptions = {}): CredentialLoader {
  const where = { env: opts.env ?? process.env, home: opts.home ?? homedir() };
  const keys = [
    apiKeyCredentials({ name: "AI_GATEWAY_API_KEY", file: "ai-gateway-api-key", what: "Vercel AI Gateway key" }, where),
    apiKeyCredentials({ name: "TYPESAFE_API_KEY", file: "typesafe-api-key", what: "TypeSafe API key" }, where),
  ];
  const first = async (): Promise<CredentialLoader | null> => {
    for (const key of keys) if ((await key.check()).available) return key;
    return null;
  };
  return {
    async check() {
      return (await first()) ? { available: true } : { available: false, reason: MISSING };
    },
    async prepare(runDir, wait) {
      const key = await first();
      if (!key) throw new NoCredentialError(MISSING);
      return key.prepare(runDir, wait);
    },
  };
}
