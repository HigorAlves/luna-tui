import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { machineSecrets } from "./machine-secrets.ts";

describe("machineSecrets", () => {
  it("names the machine's own credential values so a stored context can redact them, and leaves out what is unset or too short to be a secret", () => {
    const home = mkdtempSync(join(tmpdir(), "secrets-"));
    const secrets = machineSecrets({ githubToken: "github-value-1234", apiToken: "api-value-1234", slack: { token: "slack-value-1234", channel: "C1" }, jira: { token: "jira-value-1234" }, traces: { mode: "host", laminar: { projectApiKey: "lmnr-value-1234" } } } as never, { OPENAI_API_KEY: "openai-value-1234", ANTHROPIC_API_KEY: "", TYPESAFE_API_KEY: "ab" }, home);
    expect(secrets).toEqual({ GITHUB_TOKEN: "github-value-1234", MACHINE_API_TOKEN: "api-value-1234", MACHINE_SLACK_TOKEN: "slack-value-1234", MACHINE_JIRA_TOKEN: "jira-value-1234", LMNR_PROJECT_API_KEY: "lmnr-value-1234", OPENAI_API_KEY: "openai-value-1234" });
  });

  it("is empty for a machine with no credential", () => {
    expect(machineSecrets({ githubToken: null, apiToken: null, slack: null, jira: null, traces: { mode: "off" } } as never, {}, mkdtempSync(join(tmpdir(), "secrets-")))).toEqual({});
  });

  it("also names the Claude subscription token, the Codex login, the database password and the other Slack tokens, and never anything else of the address", () => {
    const home = mkdtempSync(join(tmpdir(), "secrets-"));
    mkdirSync(join(home, ".codex"), { recursive: true });
    mkdirSync(join(home, ".config", "hardness"), { recursive: true });
    writeFileSync(join(home, ".codex", "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "codex-access-1234", refresh_token: "codex-refresh-1234", account_id: "acct" } }));
    writeFileSync(join(home, ".config", "hardness", "claude-oauth-token"), "claude-file-token-1234\n");
    const secrets = machineSecrets({ githubToken: null, apiToken: null, slack: null, jira: null, traces: { mode: "off" }, slackInbox: { userToken: "slack-user-1234", appToken: "slack-app-1234" }, databaseUrl: "postgres://hardness:p%40ss-word-1234@127.0.0.1:5433/hardness" } as never, { CLAUDE_CODE_OAUTH_TOKEN: "claude-env-token-1234" }, home);
    expect(Object.values(secrets).sort()).toEqual(["claude-env-token-1234", "claude-file-token-1234", "codex-access-1234", "codex-refresh-1234", "p@ss-word-1234", "slack-app-1234", "slack-user-1234"].sort());
    expect(Object.keys(secrets)).toContain("DATABASE_PASSWORD");
  });
});
