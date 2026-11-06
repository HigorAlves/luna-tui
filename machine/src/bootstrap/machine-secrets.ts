// The machine's own credential values, by the variable that carries each: what a stored decision context, a truth file and a trace redact besides the token
// shapes they always match. A pack call has no run secrets of its own; these are the ones the machine itself holds: its tokens (GitHub, API, Slack bot, user and
// app, Jira, the trace key), the provider keys, the Claude subscription token, the Codex login, and the database password inside DATABASE_URL. A repository's
// own deploy and check secrets pass through the run's own redactor, not this one. A value is never printed here. Reads two small files at most. Pure otherwise.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Config } from "../config.ts";

const ENV_KEYS = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "TYPESAFE_API_KEY", "AI_GATEWAY_API_KEY"] as const;
/** The files `~/.config/hardness` may hold a provider credential in (`adapters/credentials/claude.ts`). */
const CLAUDE_FILES = [["CLAUDE_OAUTH_TOKEN_FILE", "claude-oauth-token"], ["ANTHROPIC_API_KEY_FILE", "anthropic-api-key"], ["COGNEE_OPENAI_KEY_FILE", "cognee-openai-key"], ["COGNEE_PASSWORD_FILE", "cognee-password"], ["COGNEE_JWT_SECRET_FILE", "cognee-jwt-secret"]] as const;
/** A value shorter than this is not a secret worth hunting for: redacting it would mangle ordinary text. */
const MIN_LENGTH = 8;

type Source = Pick<Config, "githubToken" | "apiToken" | "slack" | "jira" | "traces"> & Partial<Pick<Config, "slackInbox" | "databaseUrl">>;

const readText = (path: string): string | null => {
  try {
    return readFileSync(path, "utf8").replace(/\s+/g, "") || null;
  } catch {
    return null;
  }
};

/** The password of a database address, or null. */
function passwordOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const password = decodeURIComponent(new URL(url).password);
    return password || null;
  } catch {
    return null;
  }
}

/** Every string a Codex login file holds under a key that names a credential (access, refresh and id tokens, an API key). */
function codexTokens(home: string, env: NodeJS.ProcessEnv): Record<string, string> {
  const found: Record<string, string> = {};
  try {
    const parsed = JSON.parse(readFileSync(join(env.CODEX_HOME || join(home, ".codex"), "auth.json"), "utf8")) as unknown;
    const walk = (value: unknown, path: string): void => {
      if (typeof value === "string") {
        if (/token|key|secret/i.test(path)) found[`CODEX_${path.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`] = value;
      } else if (value !== null && typeof value === "object") for (const [key, item] of Object.entries(value)) walk(item, path ? `${path}.${key}` : key);
    };
    walk(parsed, "");
  } catch {
    // No login, or one that does not parse: nothing to name.
  }
  return found;
}

export function machineSecrets(config: Source, env: NodeJS.ProcessEnv, home: string = homedir()): Record<string, string> {
  const found: Record<string, string | null | undefined> = {
    GITHUB_TOKEN: config.githubToken,
    MACHINE_API_TOKEN: config.apiToken,
    MACHINE_SLACK_TOKEN: config.slack?.token,
    MACHINE_SLACK_USER_TOKEN: config.slackInbox?.userToken,
    MACHINE_SLACK_APP_TOKEN: config.slackInbox?.appToken,
    MACHINE_JIRA_TOKEN: config.jira?.token,
    LMNR_PROJECT_API_KEY: config.traces.mode === "off" ? null : config.traces.laminar.projectApiKey,
    DATABASE_PASSWORD: passwordOf(config.databaseUrl ?? env.DATABASE_URL),
    ...Object.fromEntries(ENV_KEYS.map((key) => [key, env[key]])),
    ...Object.fromEntries(CLAUDE_FILES.map(([name, file]) => [name, readText(join(home, ".config", "hardness", file))])),
    ...codexTokens(home, env),
  };
  return Object.fromEntries(Object.entries(found).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length >= MIN_LENGTH));
}
