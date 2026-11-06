// The machine's own credential values, by the variable that carries each: what a stored decision context redacts besides the token
// shapes it always matches. A pack call has no run secrets of its own; these are the ones the machine itself holds. Pure.
import type { Config } from "../config.ts";

const ENV_KEYS = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "TYPESAFE_API_KEY", "AI_GATEWAY_API_KEY"] as const;
/** A value shorter than this is not a secret worth hunting for: redacting it would mangle ordinary text. */
const MIN_LENGTH = 8;

export function machineSecrets(config: Pick<Config, "githubToken" | "apiToken" | "slack" | "jira" | "traces">, env: NodeJS.ProcessEnv): Record<string, string> {
  const found: Record<string, string | null | undefined> = {
    GITHUB_TOKEN: config.githubToken,
    MACHINE_API_TOKEN: config.apiToken,
    MACHINE_SLACK_TOKEN: config.slack?.token,
    MACHINE_JIRA_TOKEN: config.jira?.token,
    LMNR_PROJECT_API_KEY: config.traces.mode === "off" ? null : config.traces.laminar.projectApiKey,
    ...Object.fromEntries(ENV_KEYS.map((key) => [key, env[key]])),
  };
  return Object.fromEntries(Object.entries(found).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length >= MIN_LENGTH));
}
