import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { RUNNING, type TaskState } from "@hardness/contracts";

import { normaliseSite } from "./domain/datadog-site.ts";
import { DEFAULT_GATE_SECS, parseDuration } from "./domain/sla.ts";

/** Settings read from the environment. Defaults match compose.dev.yml and herdr's config. */
export interface Config {
  databaseUrl: string;
  port: number;
  /** Interface the API binds to. 127.0.0.1 on the host; 0.0.0.0 inside the compose container. */
  host: string;
  /** Run Triage and Implementer as real agents. Off: every stage is a stub. */
  agents: boolean;
  /** Tasks that can be driving a stage at once, across every repo. The rest queue. */
  maxConcurrentTasks: number;
  /** Running tasks one repo may hold at once, so it cannot take every slot; null means no cap. */
  maxPerRepo: number | null;
  /** Tasks that may drive one stage at once, e.g. `{ implementing: 2, e2e: 1 }`; a stage not named has no cap. */
  maxPerStage: Record<string, number>;
  /** Docker image for stage containers, built by `runner:build`. */
  runnerImage: string;
  /** Docker image for the e2e stage, with a browser. Used by the QA slices. */
  runnerQaImage: string;
  /** Task worktrees go in `<worktreesDir>/<repo>/<branch>`, like `herdr worktree`. */
  worktreesDir: string;
  /** Run inputs, outputs and transcripts. */
  stateDir: string;
  /** Poll GitHub issues carrying `label` in `repos` (`owner/name`) and create tasks. No repos: off. */
  githubPoll: { repos: string[]; intervalMs: number; label: string };
  /** The token every GitHub call uses (`GITHUB_TOKEN`, else `GH_TOKEN`); null means GitHub is off. */
  githubToken: string | null;
  /** The PR inbox: poll every open PR involving you. `MACHINE_GITHUB_PRS=off` turns it off. */
  githubPrs: { enabled: boolean; intervalMs: number };
  /** `owner/name` to the checkout's path, for issues GitHub intake imports. */
  repoMap: Record<string, string>;
  /** Checkouts one level under here are matched to `owner/name` by their origin remote. */
  reposDir: string;
  /** Reply in the thread a task came from (its GitHub issue; Slack when set). `MACHINE_THREAD_REPLIES=off` stops it. */
  threadReplies: boolean;
  /** A Slack bot token and channel: one thread per task is opened there. Both or neither. */
  slack: { token: string; channel: string } | null;
  /** The Slack inbox: your user token, the optional app-level token for Socket Mode, and its knobs. */
  slackInbox: SlackInboxConfig;
  /** The Datadog inbox: your API and application keys, the site and its knobs. */
  datadog: DatadogConfig;
  /** Jira Cloud: the site, your Atlassian email and API token. Null means Jira is off (unset, or `MACHINE_JIRA=off`). */
  jira: JiraConfig | null;
  /** The ticket SLAs a repo's luna.yaml does not set: the gate target (`MACHINE_SLA_GATE`, 1h) and the cycle target (`MACHINE_SLA_CYCLE`, none), in seconds. */
  sla: { gateSecs: number | null; cycleSecs: number | null };
  /** Days to keep a closed task's events/stage runs before pruning them. 0 disables pruning. */
  retentionDays: number;
  /** Days after a task closes before its worktree is removed and its merged branch deleted. 0 disables it. */
  worktreeRetentionDays: number;
  /** Spend ceiling for one task (sum of its stage runs); null means none. Over it, the task escalates. */
  taskBudgetUsd: number | null;
  /** Spend ceiling over the trailing 24 hours; null means none. Over it, nothing new is claimed. */
  dailyBudgetUsd: number | null;
  /** What happens to a task mid-stage when the machine stops: back to the queue (its stage re-runs
   *  on boot, no approval needed) or escalated for you to resume, as before. */
  restartPolicy: RestartPolicy;
}

export interface SlackInboxConfig {
  /** `MACHINE_SLACK_INBOX=off` stops polling; the routes still answer the empty snapshot. */
  enabled: boolean;
  /** The user token (`xoxp-…`) the inbox reads and posts with; null means every call says so. */
  userToken: string | null;
  /** The app-level token (`xapp-…`) for Socket Mode; null leaves the socket off. */
  appToken: string | null;
  intervalMs: number;
  /** `MACHINE_SLACK_MARK_READ=on`: done also moves your read cursor in Slack. */
  markRead: boolean;
  /** The rules file (`<stateDir>/slack-triage.md` unless `MACHINE_SLACK_RULES` says otherwise); created from the template when missing. */
  rulesPath: string;
  /** `HH:MM` local time for the morning digest DM; null means none. */
  digestAt: { hour: number; minute: number } | null;
}

export interface DatadogConfig {
  /** `MACHINE_DATADOG_INBOX=off` stops polling; the routes still answer the empty snapshot. */
  enabled: boolean;
  apiKey: string;
  appKey: string;
  /** `MACHINE_DATADOG_SITE`: `datadoghq.com`, `datadoghq.eu`, `us5.datadoghq.com` … */
  site: string;
  intervalMs: number;
  /** `MACHINE_DATADOG_SCOPE`: appended to every monitor, log and Error Tracking query, e.g. `env:prod team:payments`. */
  scope: string;
}

export interface JiraConfig {
  /** `https://acme.atlassian.net`, where issue urls point. */
  site: string;
  email: string;
  token: string;
  /** Set for a scoped API token: calls go through `https://api.atlassian.com/ex/jira/<cloudId>`. */
  cloudId: string | null;
  /** When the token expires (`MACHINE_JIRA_TOKEN_EXPIRES`, an ISO date you copy from id.atlassian.com); the machine warns daily in the last two weeks. */
  tokenExpiresAt: string | null;
}

export type RestartPolicy = "requeue" | "escalate";
const RESTART_POLICIES: readonly RestartPolicy[] = ["requeue", "escalate"];

function optionalPositiveInt(env: NodeJS.ProcessEnv, key: string): number | null {
  const raw = env[key];
  if (raw === undefined || raw === "") return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${key} must be a positive integer, got "${raw}"`);
  return value;
}

function optionalUsd(env: NodeJS.ProcessEnv, key: string): number | null {
  const raw = env[key];
  if (raw === undefined || raw === "") return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${key} must be a positive amount in USD, got "${raw}"`);
  return value;
}

/** The repository root (this file is machine/src/config.ts): a relative `MACHINE_SLACK_RULES` is taken from here. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const DEFAULT_DATABASE_URL = "postgres://hardness:hardness@127.0.0.1:5433/hardness";
export const DEFAULT_PORT = 4317;
export const DEFAULT_MAX_CONCURRENT_TASKS = 4;
export const DEFAULT_RETENTION_DAYS = 90;
export const DEFAULT_WORKTREE_RETENTION_DAYS = 7;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = env.MACHINE_PORT === undefined ? DEFAULT_PORT : Number(env.MACHINE_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`MACHINE_PORT must be a port number, got "${env.MACHINE_PORT}"`);
  }
  const maxConcurrentTasks =
    env.MACHINE_MAX_CONCURRENT === undefined
      ? DEFAULT_MAX_CONCURRENT_TASKS
      : Number(env.MACHINE_MAX_CONCURRENT);
  if (!Number.isInteger(maxConcurrentTasks) || maxConcurrentTasks < 1) {
    throw new Error(`MACHINE_MAX_CONCURRENT must be a positive integer, got "${env.MACHINE_MAX_CONCURRENT}"`);
  }
  const repos = (env.MACHINE_GITHUB_POLL ?? "")
    .split(",")
    .map((repo) => repo.trim())
    .filter((repo) => repo !== "");
  for (const repo of repos) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
      throw new Error(`MACHINE_GITHUB_POLL must list owner/name repos, got "${repo}"`);
    }
  }
  const pollSeconds = env.MACHINE_GITHUB_POLL_INTERVAL === undefined ? 300 : Number(env.MACHINE_GITHUB_POLL_INTERVAL);
  if (!Number.isInteger(pollSeconds) || pollSeconds < 1) {
    throw new Error(
      `MACHINE_GITHUB_POLL_INTERVAL must be a positive integer (seconds), got "${env.MACHINE_GITHUB_POLL_INTERVAL}"`,
    );
  }
  const prsSeconds = env.MACHINE_GITHUB_PRS_INTERVAL === undefined ? 60 : Number(env.MACHINE_GITHUB_PRS_INTERVAL);
  if (!Number.isInteger(prsSeconds) || prsSeconds < 1) {
    throw new Error(
      `MACHINE_GITHUB_PRS_INTERVAL must be a positive integer (seconds), got "${env.MACHINE_GITHUB_PRS_INTERVAL}"`,
    );
  }
  const retentionDays =
    env.MACHINE_RETENTION_DAYS === undefined ? DEFAULT_RETENTION_DAYS : Number(env.MACHINE_RETENTION_DAYS);
  if (!Number.isInteger(retentionDays) || retentionDays < 0) {
    throw new Error(`MACHINE_RETENTION_DAYS must be a non-negative integer, got "${env.MACHINE_RETENTION_DAYS}"`);
  }
  const worktreeRetentionDays =
    env.MACHINE_WORKTREE_RETENTION_DAYS === undefined ? DEFAULT_WORKTREE_RETENTION_DAYS : Number(env.MACHINE_WORKTREE_RETENTION_DAYS);
  if (!Number.isInteger(worktreeRetentionDays) || worktreeRetentionDays < 0) {
    throw new Error(`MACHINE_WORKTREE_RETENTION_DAYS must be a non-negative integer, got "${env.MACHINE_WORKTREE_RETENTION_DAYS}"`);
  }
  const restartPolicy = (env.MACHINE_RESTART_POLICY ?? "requeue") as RestartPolicy;
  if (!RESTART_POLICIES.includes(restartPolicy)) {
    throw new Error(`MACHINE_RESTART_POLICY must be requeue or escalate, got "${env.MACHINE_RESTART_POLICY}"`);
  }
  const maxPerStage: Record<string, number> = {};
  for (const pair of (env.MACHINE_MAX_PER_STAGE ?? "").split(",").map((p) => p.trim()).filter(Boolean)) {
    const match = /^([a-z0-9_]+)=(\d+)$/.exec(pair);
    const stage = match?.[1] as TaskState | undefined;
    const cap = Number(match?.[2]);
    if (!stage || !RUNNING.has(stage) || !Number.isInteger(cap) || cap < 1) {
      throw new Error(`MACHINE_MAX_PER_STAGE must list <running stage>=<positive integer> pairs, got "${pair}"`);
    }
    maxPerStage[stage] = cap;
  }
  const repoMap: Record<string, string> = {};
  for (const pair of (env.MACHINE_REPO_MAP ?? "").split(",").map((p) => p.trim()).filter(Boolean)) {
    const match = /^([\w.-]+\/[\w.-]+)=(\/.+)$/.exec(pair);
    if (!match) throw new Error(`MACHINE_REPO_MAP must list owner/name=/absolute/path pairs, got "${pair}"`);
    repoMap[match[1]!] = match[2]!;
  }
  const slackToken = env.MACHINE_SLACK_TOKEN ?? "";
  const slackChannel = env.MACHINE_SLACK_CHANNEL ?? "";
  if ((slackToken === "") !== (slackChannel === "")) {
    throw new Error("MACHINE_SLACK_TOKEN and MACHINE_SLACK_CHANNEL go together; set both or neither");
  }
  const inboxSeconds = env.MACHINE_SLACK_INBOX_INTERVAL === undefined ? 60 : Number(env.MACHINE_SLACK_INBOX_INTERVAL);
  if (!Number.isInteger(inboxSeconds) || inboxSeconds < 1) {
    throw new Error(`MACHINE_SLACK_INBOX_INTERVAL must be a positive integer (seconds), got "${env.MACHINE_SLACK_INBOX_INTERVAL}"`);
  }
  let digestAt: SlackInboxConfig["digestAt"] = null;
  if (env.MACHINE_SLACK_DIGEST_AT !== undefined && env.MACHINE_SLACK_DIGEST_AT !== "") {
    const match = /^(\d{1,2}):(\d{2})$/.exec(env.MACHINE_SLACK_DIGEST_AT);
    const hour = Number(match?.[1]);
    const minute = Number(match?.[2]);
    if (!match || hour > 23 || minute > 59) throw new Error(`MACHINE_SLACK_DIGEST_AT must be HH:MM, got "${env.MACHINE_SLACK_DIGEST_AT}"`);
    digestAt = { hour, minute };
  }
  const ddApiKey = env.MACHINE_DATADOG_API_KEY ?? "";
  const ddAppKey = env.MACHINE_DATADOG_APP_KEY ?? "";
  if ((ddApiKey === "") !== (ddAppKey === "")) throw new Error("MACHINE_DATADOG_API_KEY and MACHINE_DATADOG_APP_KEY go together; set both or neither");
  const ddSeconds = env.MACHINE_DATADOG_INTERVAL === undefined ? 120 : Number(env.MACHINE_DATADOG_INTERVAL);
  if (!Number.isInteger(ddSeconds) || ddSeconds <= 0) throw new Error(`MACHINE_DATADOG_INTERVAL must be a positive integer (seconds), got "${env.MACHINE_DATADOG_INTERVAL}"`);
  let jira: JiraConfig | null = null;
  if (env.MACHINE_JIRA !== "off") {
    const site = env.MACHINE_JIRA_SITE?.trim().replace(/\/+$/, "") ?? "";
    const email = env.MACHINE_JIRA_EMAIL?.trim() ?? "";
    const token = env.MACHINE_JIRA_TOKEN?.trim() ?? "";
    const set = [site, email, token].filter((v) => v !== "").length;
    if (set > 0 && set < 3) throw new Error("MACHINE_JIRA_SITE, MACHINE_JIRA_EMAIL and MACHINE_JIRA_TOKEN go together; set all three or none");
    if (set === 3) {
      if (!/^https:\/\/[^/\s]+$/.test(site)) throw new Error(`MACHINE_JIRA_SITE must be the site's https url, like https://acme.atlassian.net, got "${env.MACHINE_JIRA_SITE}"`);
      const expires = env.MACHINE_JIRA_TOKEN_EXPIRES?.trim() || null;
      if (expires !== null && Number.isNaN(Date.parse(expires))) throw new Error(`MACHINE_JIRA_TOKEN_EXPIRES must be an ISO date like 2027-01-31, got "${env.MACHINE_JIRA_TOKEN_EXPIRES}"`);
      jira = { site, email, token, cloudId: env.MACHINE_JIRA_CLOUD_ID?.trim() || null, tokenExpiresAt: expires };
    }
  }
  const sla = {
    gateSecs: env.MACHINE_SLA_GATE === undefined || env.MACHINE_SLA_GATE === "" ? DEFAULT_GATE_SECS : parseDuration(env.MACHINE_SLA_GATE, "MACHINE_SLA_GATE"),
    cycleSecs: env.MACHINE_SLA_CYCLE === undefined || env.MACHINE_SLA_CYCLE === "" ? null : parseDuration(env.MACHINE_SLA_CYCLE, "MACHINE_SLA_CYCLE"),
  };
  const home = env.HOME ?? homedir();
  const stateDir = env.MACHINE_STATE_DIR ?? join(home, ".local", "state", "hardness");
  const rules = env.MACHINE_SLACK_RULES?.trim();
  return {
    databaseUrl: env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
    port,
    host: env.MACHINE_HOST ?? "127.0.0.1",
    agents: env.MACHINE_AGENTS !== "off",
    maxConcurrentTasks,
    runnerImage: env.RUNNER_IMAGE ?? "hardness-runner:dev",
    runnerQaImage: env.RUNNER_QA_IMAGE ?? "hardness-runner-qa:dev",
    worktreesDir: env.WORKTREES_DIR ?? join(home, "Developer", "worktrees"),
    stateDir,
    githubPoll: { repos, intervalMs: pollSeconds * 1000, label: env.MACHINE_GITHUB_LABEL ?? "ready-for-agent" },
    githubPrs: { enabled: env.MACHINE_GITHUB_PRS !== "off", intervalMs: prsSeconds * 1000 },
    githubToken: env.GITHUB_TOKEN?.trim() || env.GH_TOKEN?.trim() || null,
    repoMap,
    reposDir: env.MACHINE_REPOS_DIR ?? join(home, "Developer"),
    threadReplies: env.MACHINE_THREAD_REPLIES !== "off",
    slack: slackToken === "" ? null : { token: slackToken, channel: slackChannel },
    slackInbox: {
      enabled: env.MACHINE_SLACK_INBOX !== "off",
      userToken: env.MACHINE_SLACK_USER_TOKEN?.trim() || null,
      appToken: env.MACHINE_SLACK_APP_TOKEN?.trim() || null,
      intervalMs: inboxSeconds * 1000,
      markRead: env.MACHINE_SLACK_MARK_READ === "on",
      rulesPath: rules ? resolve(REPO_ROOT, rules) : join(stateDir, "slack-triage.md"),
      digestAt,
    },
    datadog: {
      enabled: env.MACHINE_DATADOG_INBOX !== "off",
      apiKey: ddApiKey,
      appKey: ddAppKey,
      site: normaliseSite(env.MACHINE_DATADOG_SITE ?? "datadoghq.com"),
      intervalMs: ddSeconds * 1000,
      scope: (env.MACHINE_DATADOG_SCOPE ?? "").trim(),
    },
    jira,
    sla,
    retentionDays,
    worktreeRetentionDays,
    maxPerRepo: optionalPositiveInt(env, "MACHINE_MAX_PER_REPO"),
    maxPerStage,
    taskBudgetUsd: optionalUsd(env, "MACHINE_TASK_BUDGET_USD"),
    dailyBudgetUsd: optionalUsd(env, "MACHINE_DAILY_BUDGET_USD"),
    restartPolicy,
  };
}
