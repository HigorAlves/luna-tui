import { homedir } from "node:os";
import { join } from "node:path";

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
  /** Docker image for stage containers, built by `runner:build`. */
  runnerImage: string;
  /** Docker image for the e2e stage, with a browser. Used by the QA slices. */
  runnerQaImage: string;
  /** Task worktrees go in `<worktreesDir>/<repo>/<branch>`, like `herdr worktree`. */
  worktreesDir: string;
  /** Run inputs, outputs and transcripts. */
  stateDir: string;
  herdrBin: string;
  /** Poll GitHub issues carrying `label` in `repos` (`owner/name`) and create tasks. No repos: off. */
  githubPoll: { repos: string[]; intervalMs: number; label: string };
  /** Days to keep a closed task's events/stage runs before pruning them. 0 disables pruning. */
  retentionDays: number;
}

export const DEFAULT_DATABASE_URL = "postgres://hardness:hardness@127.0.0.1:5433/hardness";
export const DEFAULT_PORT = 4317;
export const DEFAULT_MAX_CONCURRENT_TASKS = 4;
export const DEFAULT_RETENTION_DAYS = 90;

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
  const retentionDays =
    env.MACHINE_RETENTION_DAYS === undefined ? DEFAULT_RETENTION_DAYS : Number(env.MACHINE_RETENTION_DAYS);
  if (!Number.isInteger(retentionDays) || retentionDays < 0) {
    throw new Error(`MACHINE_RETENTION_DAYS must be a non-negative integer, got "${env.MACHINE_RETENTION_DAYS}"`);
  }
  const home = env.HOME ?? homedir();
  return {
    databaseUrl: env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
    port,
    host: env.MACHINE_HOST ?? "127.0.0.1",
    agents: env.MACHINE_AGENTS !== "off",
    maxConcurrentTasks,
    runnerImage: env.RUNNER_IMAGE ?? "hardness-runner:dev",
    runnerQaImage: env.RUNNER_QA_IMAGE ?? "hardness-runner-qa:dev",
    worktreesDir: env.WORKTREES_DIR ?? join(home, "Developer", "worktrees"),
    stateDir: env.MACHINE_STATE_DIR ?? join(home, ".local", "state", "hardness"),
    herdrBin: env.HERDR_BIN ?? "herdr",
    githubPoll: { repos, intervalMs: pollSeconds * 1000, label: env.MACHINE_GITHUB_LABEL ?? "ready-for-agent" },
    retentionDays,
  };
}
