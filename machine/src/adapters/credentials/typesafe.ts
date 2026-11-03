// The TypeSafe API key for the `jev` engine: opt-in and metered; without it nothing classifies.
import { homedir } from "node:os";

import { type CredentialLoader, type CredentialOptions, apiKeyCredentials } from "./credential.ts";

/** `TYPESAFE_API_KEY`, else `~/.config/hardness/typesafe-api-key`. */
export function typesafeCredentials(opts: CredentialOptions = {}): CredentialLoader {
  return apiKeyCredentials({ name: "TYPESAFE_API_KEY", file: "typesafe-api-key", what: "TypeSafe API key" }, { env: opts.env ?? process.env, home: opts.home ?? homedir() });
}
