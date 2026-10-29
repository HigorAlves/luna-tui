import { describe, expect, it } from "vitest";

import {
  DEFAULT_DATABASE_URL,
  DEFAULT_MAX_CONCURRENT_TASKS,
  DEFAULT_PORT,
  DEFAULT_RETENTION_DAYS,
  loadConfig,
} from "./config.ts";

describe("loadConfig", () => {
  it("uses the dev defaults", () => {
    expect(loadConfig({ HOME: "/home/me" })).toEqual({
      databaseUrl: DEFAULT_DATABASE_URL,
      port: DEFAULT_PORT,
      host: "127.0.0.1",
      agents: true,
      maxConcurrentTasks: DEFAULT_MAX_CONCURRENT_TASKS,
      runnerImage: "hardness-runner:dev",
      runnerQaImage: "hardness-runner-qa:dev",
      worktreesDir: "/home/me/Developer/worktrees",
      stateDir: "/home/me/.local/state/hardness",
      githubPoll: { repos: [], intervalMs: 300_000, label: "ready-for-agent" },
      githubPrs: { enabled: true, intervalMs: 60_000 },
      githubToken: null,
      retentionDays: DEFAULT_RETENTION_DAYS,
      taskBudgetUsd: null,
      dailyBudgetUsd: null,
      restartPolicy: "requeue",
      worktreeRetentionDays: 7,
      maxPerRepo: null,
      maxPerStage: {},
      repoMap: {},
      reposDir: "/home/me/Developer",
      threadReplies: true,
      slack: null,
      slackInbox: { enabled: true, userToken: null, appToken: null, intervalMs: 60_000, markRead: false, rulesPath: expect.stringMatching(/\/\.local\/state\/hardness\/slack-triage\.md$/) as string, digestAt: null },
      jira: null,
      sla: { gateSecs: 3600, cycleSecs: null },
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
    expect(inbox).toEqual({ enabled: false, userToken: "xoxp-1", appToken: "xapp-1", intervalMs: 30_000, markRead: true, rulesPath: "/state/slack-triage.md", digestAt: { hour: 8, minute: 30 } });
    expect(loadConfig({ HOME: "/h", MACHINE_SLACK_USER_TOKEN: "" }).slackInbox.userToken).toBeNull();
    // The default follows the state dir; a relative path is taken from the repo root.
    expect(loadConfig({ HOME: "/h", MACHINE_STATE_DIR: "/var/hardness" }).slackInbox.rulesPath).toBe("/var/hardness/slack-triage.md");
    expect(loadConfig({ HOME: "/h", MACHINE_SLACK_RULES: "docs/agents/slack-triage.md" }).slackInbox.rulesPath).toMatch(/^\/.*\/docs\/agents\/slack-triage\.md$/);
    expect(loadConfig({ HOME: "/h", MACHINE_SLACK_DIGEST_AT: "" }).slackInbox.digestAt).toBeNull();
    expect(() => loadConfig({ HOME: "/h", MACHINE_SLACK_INBOX_INTERVAL: "0" })).toThrow(/MACHINE_SLACK_INBOX_INTERVAL/);
    expect(() => loadConfig({ HOME: "/h", MACHINE_SLACK_DIGEST_AT: "8am" })).toThrow(/MACHINE_SLACK_DIGEST_AT/);
    expect(() => loadConfig({ HOME: "/h", MACHINE_SLACK_DIGEST_AT: "25:00" })).toThrow(/MACHINE_SLACK_DIGEST_AT/);
  });

  it("reads the thread-reply switch and the Slack pair, which go together", () => {
    expect(loadConfig({ HOME: "/h", MACHINE_THREAD_REPLIES: "off" }).threadReplies).toBe(false);
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
    expect(() => loadConfig({ MACHINE_GITHUB_PRS_INTERVAL: "0" })).toThrow(/MACHINE_GITHUB_PRS_INTERVAL/);
    expect(loadConfig({ HOME: "/h", GITHUB_TOKEN: "ghp_a", GH_TOKEN: "ghp_b" }).githubToken).toBe("ghp_a");
    expect(loadConfig({ HOME: "/h", GH_TOKEN: " ghp_b " }).githubToken).toBe("ghp_b");
  });

  it("binds to the host in MACHINE_HOST, so a container can listen on every interface", () => {
    expect(loadConfig({ HOME: "/h", MACHINE_HOST: "0.0.0.0" }).host).toBe("0.0.0.0");
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
    expect(loadConfig({}).sla).toEqual({ gateSecs: 3600, cycleSecs: null });
    expect(loadConfig({ MACHINE_SLA_GATE: "30m", MACHINE_SLA_CYCLE: "3d" }).sla).toEqual({ gateSecs: 1800, cycleSecs: 259_200 });
    expect(loadConfig({ MACHINE_SLA_GATE: "off" }).sla.gateSecs).toBeNull();
    expect(() => loadConfig({ MACHINE_SLA_GATE: "soon" })).toThrow(/MACHINE_SLA_GATE must be a duration/);
  });
});
