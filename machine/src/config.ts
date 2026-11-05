import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { type EngineBudgets, RUNNING, type RuntimeId, type TaskState, engineBudgetKeyProblem } from "@hardness/contracts";

import type { TracesMode } from "./application/telemetry.ts";
import { isLoopback } from "./adapters/http/access.ts";
import { DEFAULT_GATE_SECS, parseDuration } from "./domain/sla.ts";

/** Settings read from the environment. Defaults match compose.dev.yml and herdr's config. */
export interface Config {
  databaseUrl: string;
  port: number;
  /** Interface the API binds to. 127.0.0.1 on the host; 0.0.0.0 inside the compose container. */
  host: string;
  /** The bearer token every API call must carry (`MACHINE_API_TOKEN`, else `~/.config/hardness/machine-api-token`); null asks for none. Required beyond loopback. Never logged. */
  apiToken: string | null;
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
  runnerVideoImage: string;
  /** Task worktrees go in `<worktreesDir>/<repo>/<branch>`, like `herdr worktree`. */
  worktreesDir: string;
  /** Run inputs, outputs and transcripts. */
  stateDir: string;
  /** Poll GitHub issues carrying `label` in `repos` (`owner/name`) and create tasks. No repos: off. */
  githubPoll: { repos: string[]; intervalMs: number; label: string };
  /** The token every GitHub call uses (`GITHUB_TOKEN`, else `GH_TOKEN`); null means GitHub is off. */
  githubToken: string | null;
  /** Seconds between checks of each repo's default branch for a graph rebuild; null (`MACHINE_GRAPH_INTERVAL=off`) turns the watch off. */
  graphIntervalSecs: number | null;
  /** The PR inbox: poll every open PR involving you. `MACHINE_GITHUB_PRS=off` turns it off. */
  githubPrs: { enabled: boolean; intervalMs: number };
  /** The ship monitor: how often it reads the shipped PR, and how many days it waits for a merge before asking a person. */
  shipPoll: { intervalMs: number; maxWaitDays: number };
  /** `owner/name` to the checkout's path, for issues GitHub intake imports. */
  repoMap: Record<string, string>;
  /** Checkouts one level under here are matched to `owner/name` by their origin remote. */
  reposDir: string;
  /** Reply in the thread a task came from (its GitHub issue; Slack when set). `MACHINE_THREAD_REPLIES=off` stops it. */
  threadReplies: boolean;
  /** Keep what the person changed or approved in the plan, under the state dir, for evals. `MACHINE_GROUND_TRUTH=off` stops it. */
  groundTruth: boolean;
  /** Keep each decision pack call's context, answer and verdicts under the state dir, for evals (`MACHINE_DECISIONS=off` stops it) and for how many days (`MACHINE_DECISIONS_RETENTION_DAYS`, 90; 0 keeps them). */
  decisions: { enabled: boolean; retentionDays: number };
  /** A Slack bot token and channel: one thread per task is opened there. Both or neither. */
  slack: { token: string; channel: string } | null;
  /** The Slack inbox: your user token, the optional app-level token for Socket Mode, and its knobs. */
  slackInbox: SlackInboxConfig;
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
  /** Runtimes whose engines this machine treats as unavailable (`MACHINE_DISABLE_RUNTIMES`): `eve`,
   *  `jev`; never `claude`, which every pack's default runs on. Read at boot. */
  disabledRuntimes: RuntimeId[];
  /** Monthly caps in USD by engine or credential (`MACHINE_ENGINE_BUDGETS`, `codex=0,openai=20,jev=5`):
   *  at a cap the engine is unavailable until the month turns. Never on Claude. */
  engineBudgets: EngineBudgets;
  /** What happens to a task mid-stage when the machine stops: back to the queue (its stage re-runs
   *  on boot, no approval needed) or escalated for you to resume, as before. */
  restartPolicy: RestartPolicy;
  /** Run traces to a local Laminar (`MACHINE_TRACES`, `LMNR_*`); `{ mode: "off" }` without a key. */
  traces: TracesConfig;
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

/** Where the machine sends run traces (`MACHINE_TRACES`, the `LMNR_*` variables); off without a key. */
export type TracesConfig =
  | { mode: "off" }
  | {
      mode: Exclude<TracesMode, "off">;
      laminar: {
        projectApiKey: string;
        /** Laminar as the machine reaches it: scheme and host, no port. */
        baseUrl: string;
        /** Laminar as a stage container reaches it (`LMNR_STAGE_BASE_URL`): the host's gateway by default. */
        stageBaseUrl: string;
        httpPort: number;
        grpcPort: number;
      };
    };

const TRACES_MODES: readonly TracesMode[] = ["off", "metadata", "full"];
/** The Laminar key's file in `~/.config/hardness`, read when `LMNR_PROJECT_API_KEY` is unset. */
export const LMNR_KEY_FILE = "lmnr-project-api-key";

function optionalPositiveInt(env: NodeJS.ProcessEnv, key: string): number | null {
  const raw = env[key];
  if (raw === undefined || raw === "") return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${key} must be a positive integer, got "${raw}"`);
  return value;
}

/** `MACHINE_GRAPH_INTERVAL`: seconds between graph rebuild checks (default 600), or `off`. */
function graphIntervalSecs(env: NodeJS.ProcessEnv): number | null {
  const raw = env.MACHINE_GRAPH_INTERVAL;
  if (raw === undefined || raw === "") return 600;
  if (raw === "off") return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`MACHINE_GRAPH_INTERVAL must be a positive integer (seconds) or off, got "${raw}"`);
  return value;
}

/** The runtimes a kill switch may turn off: every pack's default runs on claude, so it stays on. */
const SWITCHABLE: readonly RuntimeId[] = ["eve", "jev"];

/** `MACHINE_DISABLE_RUNTIMES`: a comma list of eve and jev; claude is refused, as is anything else. */
function disabledRuntimes(env: NodeJS.ProcessEnv): RuntimeId[] {
  const names = (env.MACHINE_DISABLE_RUNTIMES ?? "").split(",").map((name) => name.trim()).filter(Boolean);
  for (const name of names) {
    if (name === "claude") throw new Error("MACHINE_DISABLE_RUNTIMES cannot turn off claude: every pack's default engine runs on it");
    if (!SWITCHABLE.includes(name as RuntimeId)) throw new Error(`MACHINE_DISABLE_RUNTIMES lists runtimes (${SWITCHABLE.join(", ")}), got "${name}"`);
  }
  return [...new Set(names)] as RuntimeId[];
}

/** `MACHINE_ENGINE_BUDGETS`: `<engine or credential>=<USD>` pairs, a cap of 0 allowed; never Claude. */
function engineBudgets(env: NodeJS.ProcessEnv): EngineBudgets {
  const caps: EngineBudgets = {};
  for (const pair of (env.MACHINE_ENGINE_BUDGETS ?? "").split(",").map((p) => p.trim()).filter(Boolean)) {
    const match = /^([\w:.-]+)=(\d+(?:\.\d+)?)$/.exec(pair);
    if (!match) throw new Error(`MACHINE_ENGINE_BUDGETS must list <engine or credential>=<USD> pairs, got "${pair}"`);
    const problem = engineBudgetKeyProblem(match[1]!);
    if (problem) throw new Error(`MACHINE_ENGINE_BUDGETS: ${problem}`);
    caps[match[1]!] = Number(match[2]);
  }
  return caps;
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

/** The API token's file in `~/.config/hardness`, read by the board too. */
export const API_TOKEN_FILE = "machine-api-token";

/** A secret file's content with whitespace removed, or null. */
function secretFileSync(path: string): string | null {
  try {
    return readFileSync(path, "utf8").replace(/\s+/g, "") || null;
  } catch {
    return null;
  }
}

function portFrom(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) throw new Error(`${key} must be a port number, got "${raw}"`);
  return value;
}

/** `MACHINE_TRACES` and the Laminar address and key. Exported for the evals runner, which has no
 *  machine config of its own: `tracesConfig(process.env, homedir())`. */
export function tracesConfig(env: NodeJS.ProcessEnv, home: string): TracesConfig {
  const key = env.LMNR_PROJECT_API_KEY?.trim() || secretFileSync(join(home, ".config", "hardness", LMNR_KEY_FILE));
  const raw = env.MACHINE_TRACES?.trim();
  if (raw !== undefined && raw !== "" && !TRACES_MODES.includes(raw as TracesMode)) throw new Error(`MACHINE_TRACES must be off, metadata or full, got "${raw}"`);
  const mode = (raw || (key ? "metadata" : "off")) as TracesMode;
  if (mode === "off") return { mode };
  if (!key) throw new Error(`MACHINE_TRACES=${mode} needs a Laminar project key: set LMNR_PROJECT_API_KEY or put one in ~/.config/hardness/${LMNR_KEY_FILE}`);
  const hostUrl = (name: string, fallback: string): string => {
    const value = (env[name]?.trim() || fallback).replace(/\/+$/, "");
    if (!/^https?:\/\/[^/:\s]+$/.test(value)) throw new Error(`${name} must be a scheme and host without a port, like ${fallback}, got "${env[name]}"`);
    return value;
  };
  return {
    mode,
    laminar: {
      projectApiKey: key,
      baseUrl: hostUrl("LMNR_BASE_URL", "http://localhost"),
      stageBaseUrl: hostUrl("LMNR_STAGE_BASE_URL", "http://host.docker.internal"),
      httpPort: portFrom(env, "LMNR_HTTP_PORT", 8000),
      grpcPort: portFrom(env, "LMNR_GRPC_PORT", 8001),
    },
  };
}

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
  const shipSeconds = env.MACHINE_SHIP_POLL_INTERVAL === undefined ? 60 : Number(env.MACHINE_SHIP_POLL_INTERVAL);
  if (!Number.isInteger(shipSeconds) || shipSeconds < 1) {
    throw new Error(`MACHINE_SHIP_POLL_INTERVAL must be a positive integer (seconds), got "${env.MACHINE_SHIP_POLL_INTERVAL}"`);
  }
  const shipWaitDays = env.MACHINE_SHIP_MAX_WAIT_DAYS === undefined ? 14 : Number(env.MACHINE_SHIP_MAX_WAIT_DAYS);
  if (!Number.isInteger(shipWaitDays) || shipWaitDays < 1) {
    throw new Error(`MACHINE_SHIP_MAX_WAIT_DAYS must be a positive integer (days), got "${env.MACHINE_SHIP_MAX_WAIT_DAYS}"`);
  }
  const retentionDays =
    env.MACHINE_RETENTION_DAYS === undefined ? DEFAULT_RETENTION_DAYS : Number(env.MACHINE_RETENTION_DAYS);
  if (!Number.isInteger(retentionDays) || retentionDays < 0) {
    throw new Error(`MACHINE_RETENTION_DAYS must be a non-negative integer, got "${env.MACHINE_RETENTION_DAYS}"`);
  }
  const decisionRetentionDays = env.MACHINE_DECISIONS_RETENTION_DAYS === undefined || env.MACHINE_DECISIONS_RETENTION_DAYS === "" ? 90 : Number(env.MACHINE_DECISIONS_RETENTION_DAYS);
  if (!Number.isInteger(decisionRetentionDays) || decisionRetentionDays < 0) {
    throw new Error(`MACHINE_DECISIONS_RETENTION_DAYS must be a non-negative integer, got "${env.MACHINE_DECISIONS_RETENTION_DAYS}"`);
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
  const host = env.MACHINE_HOST ?? "127.0.0.1";
  const apiToken = env.MACHINE_API_TOKEN?.replace(/\s+/g, "") || secretFileSync(join(home, ".config", "hardness", API_TOKEN_FILE));
  if (!isLoopback(host) && apiToken === null) {
    throw new Error(
      `MACHINE_HOST=${host} reaches beyond this computer, so the API needs a token: set MACHINE_API_TOKEN or put one in ~/.config/hardness/${API_TOKEN_FILE} (e.g. openssl rand -hex 32)`,
    );
  }
  return {
    databaseUrl: env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
    port,
    host,
    apiToken,
    agents: env.MACHINE_AGENTS !== "off",
    maxConcurrentTasks,
    runnerImage: env.RUNNER_IMAGE ?? "hardness-runner:dev",
    runnerQaImage: env.RUNNER_QA_IMAGE ?? "hardness-runner-qa:dev",
    runnerVideoImage: env.RUNNER_VIDEO_IMAGE ?? "hardness-runner-video:dev",
    worktreesDir: env.WORKTREES_DIR ?? join(home, "Developer", "worktrees"),
    stateDir,
    githubPoll: { repos, intervalMs: pollSeconds * 1000, label: env.MACHINE_GITHUB_LABEL ?? "ready-for-agent" },
    githubPrs: { enabled: env.MACHINE_GITHUB_PRS !== "off", intervalMs: prsSeconds * 1000 },
    shipPoll: { intervalMs: shipSeconds * 1000, maxWaitDays: shipWaitDays },
    graphIntervalSecs: graphIntervalSecs(env),
    githubToken: env.GITHUB_TOKEN?.trim() || env.GH_TOKEN?.trim() || null,
    repoMap,
    reposDir: env.MACHINE_REPOS_DIR ?? join(home, "Developer"),
    threadReplies: env.MACHINE_THREAD_REPLIES !== "off",
    groundTruth: env.MACHINE_GROUND_TRUTH !== "off",
    decisions: { enabled: env.MACHINE_DECISIONS !== "off", retentionDays: decisionRetentionDays },
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
    jira,
    sla,
    retentionDays,
    worktreeRetentionDays,
    maxPerRepo: optionalPositiveInt(env, "MACHINE_MAX_PER_REPO"),
    maxPerStage,
    taskBudgetUsd: optionalUsd(env, "MACHINE_TASK_BUDGET_USD"),
    dailyBudgetUsd: optionalUsd(env, "MACHINE_DAILY_BUDGET_USD"),
    disabledRuntimes: disabledRuntimes(env),
    engineBudgets: engineBudgets(env),
    restartPolicy,
    traces: tracesConfig(env, home),
  };
}
