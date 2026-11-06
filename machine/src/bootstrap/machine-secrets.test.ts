import { describe, expect, it } from "vitest";

import { machineSecrets } from "./machine-secrets.ts";

describe("machineSecrets", () => {
  it("names the machine's own credential values so a stored context can redact them, and leaves out what is unset or too short to be a secret", () => {
    const secrets = machineSecrets({ githubToken: "github-value-1234", apiToken: "api-value-1234", slack: { token: "slack-value-1234", channel: "C1" }, jira: { token: "jira-value-1234" }, traces: { mode: "host", laminar: { projectApiKey: "lmnr-value-1234" } } } as never, { OPENAI_API_KEY: "openai-value-1234", ANTHROPIC_API_KEY: "", TYPESAFE_API_KEY: "ab" });
    expect(secrets).toEqual({ GITHUB_TOKEN: "github-value-1234", MACHINE_API_TOKEN: "api-value-1234", MACHINE_SLACK_TOKEN: "slack-value-1234", MACHINE_JIRA_TOKEN: "jira-value-1234", LMNR_PROJECT_API_KEY: "lmnr-value-1234", OPENAI_API_KEY: "openai-value-1234" });
  });

  it("is empty for a machine with no credential", () => {
    expect(machineSecrets({ githubToken: null, apiToken: null, slack: null, jira: null, traces: { mode: "off" } } as never, {})).toEqual({});
  });
});
