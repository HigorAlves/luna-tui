import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  DEFAULT_DATABASE_URL,
  DEFAULT_MAX_CONCURRENT_TASKS,
  DEFAULT_PORT,
  DEFAULT_RETENTION_DAYS,
  loadConfig,
  tracesConfig,
} from "./config.ts";

describe("loadConfig", () => {
  it("uses the dev defaults", () => {
    expect(loadConfig({ HOME: "/home/me" })).toEqual({
      databaseUrl: DEFAULT_DATABASE_URL,
      port: DEFAULT_PORT,
      host: "127.0.0.1",
      apiToken: null,
      agents: true,
      maxConcurrentTasks: DEFAULT_MAX_CONCURRENT_TASKS,
      runnerImage: "hardness-runner:dev",
      runnerQaImage: "hardness-runner-qa:dev",
      runnerVideoImage: "hardness-runner-video:dev",
      worktreesDir: "/home/me/Developer/worktrees",
      stateDir: "/home/me/.local/state/hardness",
      githubPoll: { repos: [], intervalMs: 300_000, label: "ready-for-agent" },
      githubPrs: { enabled: true, intervalMs: 60_000 },
      shipPoll: { intervalMs: 60_000, maxWaitDays: 14 },
      githubToken: null,
      graphIntervalSecs: 600,
      retentionDays: DEFAULT_RETENTION_DAYS,
      taskBudgetUsd: null,
      dailyBudgetUsd: null,
      disabledRuntimes: [],
      engineBudgets: {},
      restartPolicy: "requeue",
      traces: { mode: "off" },
      worktreeRetentionDays: 7,
      maxPerRepo: null,
      maxPerStage: {},
      repoMap: {},
      reposDir: "/home/me/Developer",
      threadReplies: true,
      publicUrl: null,
      groundTruth: true,
      decisions: { enabled: true, retentionDays: 90 },
      slack: null,
      slackInbox: { enabled: true, userToken: null, appToken: null, intervalMs: 60_000, markRead: false, rulesPath: expect.stringMatching(/\/\.local\/state\/hardness\/slack-triage\.md$/) as string, digestAt: null, scope: "opted_in" },
      jira: null,
      sla: { gateSecs: 172_800, cycleSecs: null },
    });
  });

  it("reads the Slack inbox's tokens and knobs", () => {
    const inbox = loadConfig({
      HOME: "/h",
      MACHINE_SLACK_USER_TOKEN: " xoxp-1 ",
      MACHINE_SLACK_APP_TOKEN: "xapp-1",
      MACHINE_SLACK_INBOX: "off",
      MACHINE_SLACK_INBOX_INTERVAL: "30",
      MACHINE_SLACK_MARK_READ: "on",
      MACHINE_SLACK_RULES: "/state/slack-triage.md",
      MACHINE_SLACK_DIGEST_AT: "08:30",
    }).slackInbox;
    expect(inbox).toEqual({ enabled: false, userToken: "xoxp-1", appToken: "xapp-1", intervalMs: 30_000, markRead: true, rulesPath: "/state/slack-triage.md", digestAt: { hour: 8, minute: 30 }, scope: "opted_in" });
    expect(loadConfig({ HOME: "/h", MACHINE_SLACK_SCOPE: "all" }).slackInbox.scope).toBe("all");
    expect(loadConfig({ HOME: "/h", MACHINE_SLACK_SCOPE: "opted_in" }).slackInbox.scope).toBe("opted_in");
    expect(() => loadConfig({ HOME: "/h", MACHINE_SLACK_SCOPE: "everything" })).toThrow(/MACHINE_SLACK_SCOPE/);
    expect(loadConfig({ HOME: "/h", MACHINE_SLACK_USER_TOKEN: "" }).slackInbox.userToken).toBeNull();
    // The default follows the state dir; a relative path is taken from the repo root.
    expect(loadConfig({ HOME: "/h", MACHINE_STATE_DIR: "/var/hardness" }).slackInbox.rulesPath).toBe("/var/hardness/slack-triage.md");
    expect(loadConfig({ HOME: "/h", MACHINE_SLACK_RULES: "docs/agents/slack-triage.md" }).slackInbox.rulesPath).toMatch(/^\/.*\/docs\/agents\/slack-triage\.md$/);
    expect(loadConfig({ HOME: "/h", MACHINE_SLACK_DIGEST_AT: "" }).slackInbox.digestAt).toBeNull();
    expect(() => loadConfig({ HOME: "/h", MACHINE_SLACK_INBOX_INTERVAL: "0" })).toThrow(/MACHINE_SLACK_INBOX_INTERVAL/);
    expect(() => loadConfig({ HOME: "/h", MACHINE_SLACK_DIGEST_AT: "8am" })).toThrow(/MACHINE_SLACK_DIGEST_AT/);
    expect(() => loadConfig({ HOME: "/h", MACHINE_SLACK_DIGEST_AT: "25:00" })).toThrow(/MACHINE_SLACK_DIGEST_AT/);
  });

  it("resolves the state dir by one rule the evals' harvest shares", async () => {
    const { stateDirFrom } = await import("./config.ts");
    expect(stateDirFrom({}, "/h")).toBe("/h/.local/state/hardness");
    expect(stateDirFrom({ MACHINE_STATE_DIR: "/s" }, "/h")).toBe("/s");
    expect(loadConfig({ HOME: "/h", MACHINE_STATE_DIR: "/s" }).stateDir).toBe("/s");
  });

  it("reads the thread-reply switch and the Slack pair, which go together", () => {
    expect(loadConfig({ HOME: "/h", MACHINE_THREAD_REPLIES: "off" }).threadReplies).toBe(false);
    expect(loadConfig({ HOME: "/h", MACHINE_PUBLIC_URL: "https://board.example/" }).publicUrl).toBe("https://board.example");
    for (const bad of ["ftp://x", "javascript:alert(1)", "https://x y", "http://127.0.0.1:4317 ", "not a url", ""]) expect(loadConfig({ HOME: "/h", MACHINE_PUBLIC_URL: bad }).publicUrl, bad).toBeNull();
    expect(loadConfig({ HOME: "/h" }).groundTruth).toBe(true);
    expect(loadConfig({ HOME: "/h", MACHINE_GROUND_TRUTH: "off" }).groundTruth).toBe(false);
    expect(loadConfig({ HOME: "/h", MACHINE_DECISIONS: "off" }).decisions.enabled).toBe(false);
    expect(loadConfig({ HOME: "/h", MACHINE_DECISIONS_RETENTION_DAYS: "7" }).decisions.retentionDays).toBe(7);
    expect(() => loadConfig({ HOME: "/h", MACHINE_DECISIONS_RETENTION_DAYS: "-1" })).toThrow(/MACHINE_DECISIONS_RETENTION_DAYS/);
    expect(loadConfig({ HOME: "/h", MACHINE_SLACK_TOKEN: "xoxb", MACHINE_SLACK_CHANNEL: "C1" }).slack).toEqual({ token: "xoxb", channel: "C1" });
    expect(() => loadConfig({ HOME: "/h", MACHINE_SLACK_TOKEN: "xoxb" })).toThrow(/MACHINE_SLACK_CHANNEL/);
  });

  it("caps the running tasks per repo only when told to", () => {
    expect(loadConfig({ HOME: "/home/me" }).maxPerRepo).toBeNull();
    expect(loadConfig({ HOME: "/home/me", MACHINE_MAX_PER_REPO: "2" }).maxPerRepo).toBe(2);
    expect(() => loadConfig({ MACHINE_MAX_PER_REPO: "0" })).toThrow(/MACHINE_MAX_PER_REPO/);
    expect(() => loadConfig({ MACHINE_MAX_PER_REPO: "two" })).toThrow(/MACHINE_MAX_PER_REPO/);
  });

  it("maps GitHub repos to local paths from MACHINE_REPO_MAP, and scans MACHINE_REPOS_DIR otherwise", () => {
    expect(loadConfig({ HOME: "/home/me" }).repoMap).toEqual({});
    expect(loadConfig({ HOME: "/home/me" }).reposDir).toBe("/home/me/Developer");
    expect(loadConfig({ HOME: "/h", MACHINE_REPO_MAP: "o/a=/r/a, o/b=/r/b", MACHINE_REPOS_DIR: "/r" })).toMatchObject({
      repoMap: { "o/a": "/r/a", "o/b": "/r/b" },
      reposDir: "/r",
    });
    expect(() => loadConfig({ MACHINE_REPO_MAP: "o/a" })).toThrow(/MACHINE_REPO_MAP/);
    expect(() => loadConfig({ MACHINE_REPO_MAP: "oa=/r/a" })).toThrow(/MACHINE_REPO_MAP/);
  });

  it("reads the GitHub poll settings", () => {
    expect(
      loadConfig({
        HOME: "/h",
        MACHINE_GITHUB_POLL: "a/b, c/d,",
        MACHINE_GITHUB_POLL_INTERVAL: "60",
        MACHINE_GITHUB_LABEL: "go",
      }).githubPoll,
    ).toEqual({ repos: ["a/b", "c/d"], intervalMs: 60_000, label: "go" });
  });

  it("rejects a bad poll interval or repo", () => {
    expect(() => loadConfig({ MACHINE_GITHUB_POLL_INTERVAL: "0" })).toThrow(/MACHINE_GITHUB_POLL_INTERVAL/);
    expect(() => loadConfig({ MACHINE_GITHUB_POLL_INTERVAL: "x" })).toThrow(/MACHINE_GITHUB_POLL_INTERVAL/);
    expect(() => loadConfig({ MACHINE_GITHUB_POLL: "nope" })).toThrow(/MACHINE_GITHUB_POLL/);
    expect(loadConfig({ HOME: "/h", MACHINE_GITHUB_PRS: "off", MACHINE_GITHUB_PRS_INTERVAL: "120" }).githubPrs).toEqual({ enabled: false, intervalMs: 120_000 });
    expect(loadConfig({ HOME: "/h", MACHINE_SHIP_POLL_INTERVAL: "5", MACHINE_SHIP_MAX_WAIT_DAYS: "3" }).shipPoll).toEqual({ intervalMs: 5_000, maxWaitDays: 3 });
    expect(() => loadConfig({ HOME: "/h", MACHINE_SHIP_POLL_INTERVAL: "0" })).toThrow(/MACHINE_SHIP_POLL_INTERVAL/);
    expect(() => loadConfig({ HOME: "/h", MACHINE_SHIP_MAX_WAIT_DAYS: "x" })).toThrow(/MACHINE_SHIP_MAX_WAIT_DAYS/);
    expect(() => loadConfig({ MACHINE_GITHUB_PRS_INTERVAL: "0" })).toThrow(/MACHINE_GITHUB_PRS_INTERVAL/);
    expect(loadConfig({ HOME: "/h", GITHUB_TOKEN: "ghp_a", GH_TOKEN: "ghp_b" }).githubToken).toBe("ghp_a");
    expect(loadConfig({ HOME: "/h", GH_TOKEN: " ghp_b " }).githubToken).toBe("ghp_b");
  });

  it("reads the graph watch's interval: seconds, off to disable, anything else is refused", () => {
    expect(loadConfig({ HOME: "/h", MACHINE_GRAPH_INTERVAL: "30" }).graphIntervalSecs).toBe(30);
    expect(loadConfig({ HOME: "/h", MACHINE_GRAPH_INTERVAL: "off" }).graphIntervalSecs).toBeNull();
    expect(() => loadConfig({ HOME: "/h", MACHINE_GRAPH_INTERVAL: "soon" })).toThrow(/MACHINE_GRAPH_INTERVAL/);
    expect(() => loadConfig({ HOME: "/h", MACHINE_GRAPH_INTERVAL: "0" })).toThrow(/MACHINE_GRAPH_INTERVAL/);
  });

  it("binds to the host in MACHINE_HOST, so a container can listen on every interface", () => {
    expect(loadConfig({ HOME: "/h", MACHINE_HOST: "0.0.0.0", MACHINE_API_TOKEN: "t" }).host).toBe("0.0.0.0");
  });

  it("reads the API token from MACHINE_API_TOKEN, else ~/.config/hardness/machine-api-token, else none", () => {
    expect(loadConfig({ HOME: "/h" }).apiToken).toBeNull();
    expect(loadConfig({ HOME: "/h", MACHINE_API_TOKEN: " s3cret " }).apiToken).toBe("s3cret");
    const home = mkdtempSync(join(tmpdir(), "home-"));
    mkdirSync(join(home, ".config", "hardness"), { recursive: true });
    writeFileSync(join(home, ".config", "hardness", "machine-api-token"), "from-file\n");
    expect(loadConfig({ HOME: home }).apiToken).toBe("from-file");
    expect(loadConfig({ HOME: home, MACHINE_API_TOKEN: "from-env" }).apiToken).toBe("from-env");
  });

  it("refuses to start beyond loopback without an API token, and says how to set one", () => {
    expect(() => loadConfig({ HOME: "/h", MACHINE_HOST: "0.0.0.0" })).toThrow(/MACHINE_API_TOKEN/);
    expect(() => loadConfig({ HOME: "/h", MACHINE_HOST: "192.168.1.5" })).toThrow(/machine-api-token/);
    for (const host of ["127.0.0.1", "localhost", "::1", "127.0.0.2"]) {
      expect(loadConfig({ HOME: "/h", MACHINE_HOST: host }).host).toBe(host);
    }
  });

  it("rejects a port that is not a number", () => {
    expect(() => loadConfig({ MACHINE_PORT: "abc" })).toThrow(/MACHINE_PORT/);
  });

  it("reads a custom concurrency limit", () => {
    expect(loadConfig({ HOME: "/home/me", MACHINE_MAX_CONCURRENT: "8" }).maxConcurrentTasks).toBe(8);
  });

  it("rejects a concurrency limit that is not a positive integer", () => {
    expect(() => loadConfig({ MACHINE_MAX_CONCURRENT: "0" })).toThrow(/MACHINE_MAX_CONCURRENT/);
    expect(() => loadConfig({ MACHINE_MAX_CONCURRENT: "abc" })).toThrow(/MACHINE_MAX_CONCURRENT/);
  });

  it("requeues running tasks on shutdown unless told to escalate them", () => {
    expect(loadConfig({ HOME: "/home/me" }).restartPolicy).toBe("requeue");
    expect(loadConfig({ HOME: "/home/me", MACHINE_RESTART_POLICY: "escalate" }).restartPolicy).toBe("escalate");
    expect(() => loadConfig({ MACHINE_RESTART_POLICY: "resume" })).toThrow(/MACHINE_RESTART_POLICY/);
  });

  it("sweeps closed tasks' worktrees after a week unless told otherwise", () => {
    expect(loadConfig({ HOME: "/home/me" }).worktreeRetentionDays).toBe(7);
    expect(loadConfig({ HOME: "/home/me", MACHINE_WORKTREE_RETENTION_DAYS: "0" }).worktreeRetentionDays).toBe(0);
    expect(() => loadConfig({ MACHINE_WORKTREE_RETENTION_DAYS: "soon" })).toThrow(/MACHINE_WORKTREE_RETENTION_DAYS/);
  });

  it("has no spend ceilings unless you set them", () => {
    const config = loadConfig({ HOME: "/home/me" });
    expect(config.taskBudgetUsd).toBeNull();
    expect(config.dailyBudgetUsd).toBeNull();
    const set = loadConfig({ HOME: "/home/me", MACHINE_TASK_BUDGET_USD: "2.5", MACHINE_DAILY_BUDGET_USD: "40" });
    expect(set.taskBudgetUsd).toBe(2.5);
    expect(set.dailyBudgetUsd).toBe(40);
  });

  it("rejects a ceiling that is not a positive amount", () => {
    expect(() => loadConfig({ MACHINE_TASK_BUDGET_USD: "0" })).toThrow(/MACHINE_TASK_BUDGET_USD/);
    expect(() => loadConfig({ MACHINE_DAILY_BUDGET_USD: "lots" })).toThrow(/MACHINE_DAILY_BUDGET_USD/);
  });

  it("turns runtimes off with MACHINE_DISABLE_RUNTIMES, eve and jev only: every pack's default runs on claude", () => {
    expect(loadConfig({ HOME: "/home/me" }).disabledRuntimes).toEqual([]);
    expect(loadConfig({ HOME: "/home/me", MACHINE_DISABLE_RUNTIMES: "eve" }).disabledRuntimes).toEqual(["eve"]);
    expect(loadConfig({ HOME: "/home/me", MACHINE_DISABLE_RUNTIMES: " jev , eve,jev " }).disabledRuntimes).toEqual(["jev", "eve"]);
    expect(() => loadConfig({ HOME: "/home/me", MACHINE_DISABLE_RUNTIMES: "eve,claude" })).toThrow("MACHINE_DISABLE_RUNTIMES cannot turn off claude: every pack's default engine runs on it");
    expect(() => loadConfig({ HOME: "/home/me", MACHINE_DISABLE_RUNTIMES: "codex" })).toThrow(/MACHINE_DISABLE_RUNTIMES lists runtimes \(eve, jev\), got "codex"/);
  });

  it("reads monthly caps per engine or credential from MACHINE_ENGINE_BUDGETS, and refuses Claude, unknown names and bad amounts", () => {
    expect(loadConfig({ HOME: "/home/me", MACHINE_ENGINE_BUDGETS: "codex=0, openai=20,jev=5,openai:luna=2.5" }).engineBudgets).toEqual({ codex: 0, openai: 20, jev: 5, "openai:luna": 2.5 });
    expect(() => loadConfig({ HOME: "/home/me", MACHINE_ENGINE_BUDGETS: "claude=50" })).toThrow(/^MACHINE_ENGINE_BUDGETS: claude: no monthly cap on Claude/);
    expect(() => loadConfig({ HOME: "/home/me", MACHINE_ENGINE_BUDGETS: "gpt=5" })).toThrow(/^MACHINE_ENGINE_BUDGETS: gpt: not an engine or a credential/);
    expect(() => loadConfig({ HOME: "/home/me", MACHINE_ENGINE_BUDGETS: "openai=lots" })).toThrow('MACHINE_ENGINE_BUDGETS must list <engine or credential>=<USD> pairs, got "openai=lots"');
    expect(() => loadConfig({ HOME: "/home/me", MACHINE_ENGINE_BUDGETS: "openai=-1" })).toThrow(/MACHINE_ENGINE_BUDGETS must list/);
  });

  it("turns traces off without a Laminar key, and on (metadata) with one", () => {
    expect(loadConfig({ HOME: "/home/me" }).traces).toEqual({ mode: "off" });
    expect(loadConfig({ HOME: "/home/me", LMNR_PROJECT_API_KEY: " key-1 " }).traces).toEqual({
      mode: "metadata",
      laminar: { projectApiKey: "key-1", baseUrl: "http://localhost", stageBaseUrl: "http://host.docker.internal", httpPort: 8000, grpcPort: 8001 },
    });
  });

  it("reads MACHINE_TRACES and the LMNR_* address, and refuses a mode without a key or a bad value", () => {
    expect(loadConfig({ HOME: "/home/me", LMNR_PROJECT_API_KEY: "k", MACHINE_TRACES: "full", LMNR_BASE_URL: "http://lmnr-app/", LMNR_STAGE_BASE_URL: "http://lmnr-app", LMNR_HTTP_PORT: "8100", LMNR_GRPC_PORT: "8101" }).traces).toEqual({
      mode: "full",
      laminar: { projectApiKey: "k", baseUrl: "http://lmnr-app", stageBaseUrl: "http://lmnr-app", httpPort: 8100, grpcPort: 8101 },
    });
    expect(loadConfig({ HOME: "/home/me", LMNR_PROJECT_API_KEY: "k", MACHINE_TRACES: "off" }).traces).toEqual({ mode: "off" });
    expect(() => loadConfig({ HOME: "/home/me", MACHINE_TRACES: "full" })).toThrow(/^MACHINE_TRACES=full needs a Laminar project key: set LMNR_PROJECT_API_KEY/);
    expect(() => loadConfig({ HOME: "/home/me", LMNR_PROJECT_API_KEY: "k", MACHINE_TRACES: "loud" })).toThrow(/^MACHINE_TRACES must be off, metadata or full, got "loud"/);
    expect(() => loadConfig({ HOME: "/home/me", LMNR_PROJECT_API_KEY: "k", LMNR_HTTP_PORT: "x" })).toThrow(/^LMNR_HTTP_PORT must be a port number, got "x"/);
    expect(() => loadConfig({ HOME: "/home/me", LMNR_PROJECT_API_KEY: "k", LMNR_BASE_URL: "localhost:8000" })).toThrow(/^LMNR_BASE_URL must be a scheme and host without a port, like http:\/\/localhost, got "localhost:8000"/);
    expect(() => loadConfig({ HOME: "/home/me", LMNR_PROJECT_API_KEY: "k", LMNR_STAGE_BASE_URL: "host.docker.internal:8001" })).toThrow(/^LMNR_STAGE_BASE_URL must be a scheme and host without a port/);
  });

  it("reads the Laminar key from ~/.config/hardness/lmnr-project-api-key when the variable is unset", () => {
    const home = mkdtempSync(join(tmpdir(), "config-home-"));
    mkdirSync(join(home, ".config", "hardness"), { recursive: true });
    writeFileSync(join(home, ".config", "hardness", "lmnr-project-api-key"), "from-file\n");
    expect(tracesConfig({}, home)).toEqual({ mode: "metadata", laminar: { projectApiKey: "from-file", baseUrl: "http://localhost", stageBaseUrl: "http://host.docker.internal", httpPort: 8000, grpcPort: 8001 } });
    expect(tracesConfig({ LMNR_PROJECT_API_KEY: "from-env" }, home)).toMatchObject({ laminar: { projectApiKey: "from-env" } });
  });

  it("reads a custom retention window, including 0 to disable pruning", () => {
    expect(loadConfig({ HOME: "/home/me", MACHINE_RETENTION_DAYS: "30" }).retentionDays).toBe(30);
    expect(loadConfig({ HOME: "/home/me", MACHINE_RETENTION_DAYS: "0" }).retentionDays).toBe(0);
  });

  it("rejects a retention window that is not a non-negative integer", () => {
    expect(() => loadConfig({ MACHINE_RETENTION_DAYS: "-1" })).toThrow(/MACHINE_RETENTION_DAYS/);
    expect(() => loadConfig({ MACHINE_RETENTION_DAYS: "abc" })).toThrow(/MACHINE_RETENTION_DAYS/);
  });

  it("reads Jira when all three variables are set, refuses a partial set, and honours the off switch and the cloud id", () => {
    expect(loadConfig({}).jira).toBeNull();
    const env = { MACHINE_JIRA_SITE: "https://acme.atlassian.net/", MACHINE_JIRA_EMAIL: "me@acme.com", MACHINE_JIRA_TOKEN: "tok" };
    expect(loadConfig(env).jira).toEqual({ site: "https://acme.atlassian.net", email: "me@acme.com", token: "tok", cloudId: null, tokenExpiresAt: null });
    expect(loadConfig({ ...env, MACHINE_JIRA_TOKEN_EXPIRES: "2027-01-31" }).jira?.tokenExpiresAt).toBe("2027-01-31");
    expect(() => loadConfig({ ...env, MACHINE_JIRA_TOKEN_EXPIRES: "next year" })).toThrow(/MACHINE_JIRA_TOKEN_EXPIRES must be an ISO date/);
    expect(loadConfig({ ...env, MACHINE_JIRA_CLOUD_ID: "1111-2222" }).jira?.cloudId).toBe("1111-2222");
    expect(loadConfig({ ...env, MACHINE_JIRA: "off" }).jira).toBeNull();
    expect(() => loadConfig({ MACHINE_JIRA_SITE: "https://acme.atlassian.net" })).toThrow(/go together/);
    expect(() => loadConfig({ ...env, MACHINE_JIRA_SITE: "acme.atlassian.net" })).toThrow(/MACHINE_JIRA_SITE must be the site's https url/);
  });

  it("reads the SLA defaults: a one-hour gate unless told otherwise, no cycle unless told, off for none", () => {
    expect(loadConfig({}).sla).toEqual({ gateSecs: 172_800, cycleSecs: null });
    expect(loadConfig({ MACHINE_SLA_GATE: "30m", MACHINE_SLA_CYCLE: "3d" }).sla).toEqual({ gateSecs: 1800, cycleSecs: 259_200 });
    expect(loadConfig({ MACHINE_SLA_GATE: "off" }).sla.gateSecs).toBeNull();
    expect(() => loadConfig({ MACHINE_SLA_GATE: "soon" })).toThrow(/MACHINE_SLA_GATE must be a duration/);
  });
});
