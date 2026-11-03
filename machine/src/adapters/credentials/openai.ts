// The OpenAI API key for `openai:*` engines: opt-in and metered, unlike the Codex login.
import { homedir } from "node:os";

import { type CredentialLoader, type CredentialOptions, apiKeyCredentials } from "./credential.ts";

/** `OPENAI_API_KEY`, else `~/.config/hardness/openai-api-key`. */
export function openaiCredentials(opts: CredentialOptions = {}): CredentialLoader {
  return apiKeyCredentials({ name: "OPENAI_API_KEY", file: "openai-api-key", what: "OpenAI API key" }, { env: opts.env ?? process.env, home: opts.home ?? homedir() });
}
